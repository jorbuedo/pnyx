#!/usr/bin/env bash
# Build and install the token-holding proxy on its box.
#
# Usage:  PROXY_SSH=user@<host> infra/proxy/push.sh
#         PROXY_SSH=user@<host> SKIP_UNIT=1 infra/proxy/push.sh     # code only, leave the unit alone
#         PROXY_SSH=user@<host> PROXY_BUILD=remote infra/proxy/push.sh   # build there instead
#
# ⚠️ This never touches /etc/pnyx-proxy/secrets.env. The credentials are placed by hand, once, and
# a deploy script that could overwrite them is a deploy script that can empty them.
#
# ⚠️ Nor does it install proxy.toml, and that is deliberate twice over: the deployed file is a
# TRIMMED version of proxy.example.toml (commentary lives in the repo), so copying the template over
# it would replace a hand-maintained file with a different one, and a textual diff between them is
# noise by construction.
#
# What it does instead is compare what the two actually DECLARE -- route prefixes and credential
# names. Leaving that unchecked cost a working route: `proxy.example.toml` gained
# `/midnight/preprod`, the box never did, and the repo and the live proxy disagreed silently until a
# request returned `404 no route for this path` (2026-10-19).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REMOTE="${PROXY_SSH:?set PROXY_SSH, e.g. pnyxproxy@<host>}"
REMOTE_SRC="${PROXY_DIR:-/opt/pnyx-proxy}"
BUILD="${PROXY_BUILD:-local}"

# Default is a LOCAL build shipped as a binary, so no toolchain lands on a production box. That is
# safe only if the target's glibc is at least what the binary references, so it is checked rather
# than assumed — glibc is backward compatible, so building against an older one is fine and
# building against a newer one fails at exec time on the target, not here.
#
# A static musl build would sidestep glibc entirely but needs an `x86_64-linux-musl-gcc` to compile
# rustls' `ring`, which this workstation does not carry.
if [[ "$BUILD" == "local" ]]; then
  echo "==> building locally"
  (cd "$REPO_ROOT/infra/proxy" && cargo build --release)
  BIN="$REPO_ROOT/infra/proxy/target/release/pnyx-proxy"

  need="$(objdump -T "$BIN" | grep -o 'GLIBC_[0-9.]*' | sed 's/GLIBC_//' | sort -uV | tail -1)"
  have="$(ssh "$REMOTE" 'ldd --version | head -1 | grep -o "[0-9]\+\.[0-9]\+$"')"
  echo "==> glibc: binary needs $need, $REMOTE has $have"
  if [[ "$(printf '%s\n%s\n' "$need" "$have" | sort -V | tail -1)" != "$have" ]]; then
    echo "error: $REMOTE has glibc $have but this binary needs $need." >&2
    echo "  Re-run with PROXY_BUILD=remote to build on the box instead." >&2
    exit 1
  fi

  echo "==> installing the binary"
  scp -q "$BIN" "$REMOTE:/tmp/pnyx-proxy.new"
  ssh "$REMOTE" "sudo install -m 0755 /tmp/pnyx-proxy.new /usr/local/bin/pnyx-proxy && rm -f /tmp/pnyx-proxy.new"
else
  echo "==> pushing source to $REMOTE:$REMOTE_SRC"
  ssh "$REMOTE" "mkdir -p $REMOTE_SRC"
  rsync -az "$REPO_ROOT/infra/proxy/Cargo.toml" "$REPO_ROOT/infra/proxy/Cargo.lock" "$REMOTE:$REMOTE_SRC/"
  rsync -az --delete "$REPO_ROOT/infra/proxy/src/" "$REMOTE:$REMOTE_SRC/src/"

  if ! ssh "$REMOTE" 'command -v cargo >/dev/null 2>&1 || [ -x "$HOME/.cargo/bin/cargo" ]'; then
    if [[ "${PROXY_BOOTSTRAP_RUST:-}" != "1" ]]; then
      echo "error: no cargo on $REMOTE. Re-run with PROXY_BOOTSTRAP_RUST=1 to install rustup" >&2
      echo "  into that user's home (no root), or drop PROXY_BUILD=remote to ship a binary." >&2
      exit 1
    fi
    echo "==> installing rustup on the box (user-local, no root)"
    ssh "$REMOTE" "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal"
  fi

  echo "==> building on the box"
  ssh "$REMOTE" "export PATH=\"\$HOME/.cargo/bin:\$PATH\"; cd $REMOTE_SRC && cargo build --release"
  ssh "$REMOTE" "sudo install -m 0755 $REMOTE_SRC/target/release/pnyx-proxy /usr/local/bin/pnyx-proxy"
fi

# Compare what each side DECLARES, not how it reads: the deployed file is trimmed, so a textual
# diff is always dirty and would be ignored within a week.
echo "==> config: routes and credentials declared, box vs repo"
declares() { grep -oE '^\s*(prefix = "[^"]+"|\[credential\.[a-z0-9-]+\])' | tr -d ' ' | sort -u; }
if ssh "$REMOTE" 'test -r /etc/pnyx-proxy/proxy.toml'; then
  ssh "$REMOTE" 'cat /etc/pnyx-proxy/proxy.toml' | declares > /tmp/pnyx-proxy-box.txt
  declares < "$REPO_ROOT/infra/proxy/proxy.example.toml" > /tmp/pnyx-proxy-repo.txt
  missing="$(comm -13 /tmp/pnyx-proxy-box.txt /tmp/pnyx-proxy-repo.txt)"
  extra="$(comm -23 /tmp/pnyx-proxy-box.txt /tmp/pnyx-proxy-repo.txt)"
  if [[ -z "$missing" && -z "$extra" ]]; then
    echo "    in sync"
  else
    [[ -n "$missing" ]] && { echo "    ⚠️  the box is MISSING, so these 404 or run uncredentialled:"; sed 's/^/      /' <<< "$missing"; }
    [[ -n "$extra" ]] && { echo "    ⚠️  the box declares what the repo does not:"; sed 's/^/      /' <<< "$extra"; }
    echo "    Edit /etc/pnyx-proxy/proxy.toml by hand; it is trimmed on purpose."
  fi
  rm -f /tmp/pnyx-proxy-box.txt /tmp/pnyx-proxy-repo.txt
else
  echo "    ⚠️  no readable /etc/pnyx-proxy/proxy.toml on the box"
fi

if [[ "${SKIP_UNIT:-}" != "1" ]]; then
  echo "==> installing the unit"
  scp -q "$REPO_ROOT/infra/proxy/pnyx-proxy.service" "$REMOTE:/tmp/pnyx-proxy.service"
  ssh "$REMOTE" "sudo install -m 0644 /tmp/pnyx-proxy.service /etc/systemd/system/pnyx-proxy.service && rm -f /tmp/pnyx-proxy.service && sudo systemctl daemon-reload"
fi

echo "==> restarting"
ssh "$REMOTE" "sudo systemctl restart pnyx-proxy && sleep 2 && systemctl is-active pnyx-proxy"

echo "==> /healthz"
# Proves the process is answering AND that its credential file parsed — a proxy that started but
# found no keys reports every credential as exhausted here rather than at the first user request.
ssh "$REMOTE" "curl -fsS http://127.0.0.1:8787/healthz" && echo
