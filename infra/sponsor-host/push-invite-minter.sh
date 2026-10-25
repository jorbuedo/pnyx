#!/usr/bin/env bash
# Give the sponsor host what it needs to mint a circle invite: the `pnyx_txgen` binary and
# `issueInvite`'s three ZK artifacts.
#
# ⚠️ **This is the one thing on the box that a contract redeploy invalidates.** `docs/SPONSOR_HOST.md`
# promises no contract module and no ZK artifact lives here, and the minting path breaks that
# deliberately: a proof for `issueInvite` has to be against the compile the circles were deployed
# from. The manifest digest is written beside the artifacts and checked by the service at boot, so a
# stale mirror refuses rather than proving something no circle will accept. **Re-run this after every
# recompile of `circle.compact`.**
#
# Usage:
#   SPONSOR_SSH=sponsor@<host> infra/sponsor-host/push-invite-minter.sh
#
# The binary is built here rather than on the box: the host runs Bun and has no cargo, 2 vCPU and
# 3 GB — a from-scratch build of the midnight crate tree there would take longer than the box has
# memory for. It is a plain dynamically-linked x86_64 binary whose highest glibc requirement is 2.34,
# well under Debian 13's 2.41, which is checked below rather than assumed.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REMOTE="${SPONSOR_SSH:?set SPONSOR_SSH, e.g. sponsor@<host>}"
BIN_DIR="${SPONSOR_BIN_DIR:-/var/lib/sponsor/bin}"
ART_DIR="${SPONSOR_CIRCLE_ARTIFACTS_DIR:-/var/lib/sponsor/circle-artifacts}"
ARTIFACTS_ORIGIN="${ARTIFACTS_ORIGIN:-https://artifacts.pxkq.uk}"
RUST_DIR="$REPO_ROOT/packages/midnight-native/rust"
BINARY="$RUST_DIR/target/release/examples/pnyx_txgen"

echo "==> building pnyx_txgen (release)"
(cd "$RUST_DIR" && cargo build --release --example pnyx_txgen)

# The one portability question, answered rather than assumed. A binary built on a newer glibc than the
# host's fails at exec with a symbol-version error naming no cause anyone would connect to this script.
MAX_GLIBC="$(objdump -T "$BINARY" | grep -o 'GLIBC_[0-9.]*' | sort -uV | tail -1)"
HOST_GLIBC="GLIBC_$(ssh "$REMOTE" 'ldd --version | head -1 | grep -o "[0-9]\+\.[0-9]\+$"')"
echo "    needs at most $MAX_GLIBC; the host has $HOST_GLIBC"
if [[ "$(printf '%s\n%s\n' "$MAX_GLIBC" "$HOST_GLIBC" | sort -V | tail -1)" != "$HOST_GLIBC" ]]; then
  echo "FAILED — this binary needs $MAX_GLIBC and the host has $HOST_GLIBC." >&2
  echo "         Build it in a container matching the host's distribution instead." >&2
  exit 1
fi

echo "==> pushing the binary to $REMOTE:$BIN_DIR"
ssh "$REMOTE" "mkdir -p $BIN_DIR $ART_DIR/zkir $ART_DIR/keys"
# To `.part` then rename: a push interrupted mid-transfer must never leave a truncated binary under
# the name the service execs.
scp -q "$BINARY" "$REMOTE:$BIN_DIR/pnyx_txgen.part"
ssh "$REMOTE" "chmod +x $BIN_DIR/pnyx_txgen.part && mv $BIN_DIR/pnyx_txgen.part $BIN_DIR/pnyx_txgen"
ssh "$REMOTE" "$BIN_DIR/pnyx_txgen 2>&1 | head -1"

echo "==> mirroring issueInvite's artifacts from $ARTIFACTS_ORIGIN"
# ⚠️ **The manifest is parsed here, not on the box.** It was parsed there with `grep -o` over the raw
# JSON, and the pattern for a circuit's second and third entries could not cross the `}` that closed
# its first — so the prover key was never fetched and the run stopped with the mirror half-built. A
# real parser locally, three literal hashes over the wire.
manifest="$(curl -fsS "$ARTIFACTS_ORIGIN/circle/manifest.json")"
read -r DIGEST BZKIR PROVER VERIFIER <<<"$(
  printf '%s' "$manifest" | python3 -c '
import json, sys
m = json.load(sys.stdin)
c = m["circuits"]["issueInvite"]
print(m["codeDigest"], c["bzkir"]["sha256"], c["prover"]["sha256"], c["verifier"]["sha256"])
'
)"
echo "    manifest codeDigest: $DIGEST"

ssh "$REMOTE" bash -s -- "$ARTIFACTS_ORIGIN" "$ART_DIR" "$DIGEST" "$BZKIR" "$PROVER" "$VERIFIER" <<'REMOTE_SCRIPT'
set -euo pipefail
ORIGIN="$1"; DIR="$2"; DIGEST="$3"; BZKIR="$4"; PROVER="$5"; VERIFIER="$6"

fetch() { # <circuit> <kind> <dest-subdir> <want-sha256>
  # Verified against the manifest's own hash: `curl -f` already rejects an error page, but a truncated
  # prover key fails inside the prover with nothing naming the file. `.part` then rename, so a run that
  # dies mid-transfer never publishes a short file under its real name.
  curl -fsS --retry 3 -o "$DIR/$3/$1.$2.part" "$ORIGIN/circle/$1.$2"
  got="$(sha256sum "$DIR/$3/$1.$2.part" | cut -d' ' -f1)"
  if [ "$got" != "$4" ]; then
    rm -f "$DIR/$3/$1.$2.part"
    echo "$1.$2 hashed $got, the manifest says $4" >&2
    exit 1
  fi
  mv "$DIR/$3/$1.$2.part" "$DIR/$3/$1.$2"
  echo "    $1.$2 ok ($(stat -c%s "$DIR/$3/$1.$2") bytes)"
}

# The layout `pnyx_txgen` expects of a managed directory: `zkir/<circuit>.bzkir`,
# `keys/<circuit>.prover`, `keys/<circuit>.verifier`. Named individually rather than looped over the
# manifest because this host needs exactly one circuit and mirroring the other six would be ~17 MB it
# never reads.
fetch issueInvite bzkir zkir "$BZKIR"
fetch issueInvite prover keys "$PROVER"
fetch issueInvite verifier keys "$VERIFIER"

# Written last, so a half-finished mirror never claims a digest. The service compares it to
# CIRCLE_CODE_DIGEST at boot and refuses to mint on a mismatch — proving against a template no
# deployed circle was built from would produce a transaction every circle rejects.
printf '%s\n' "$DIGEST" > "$DIR/codeDigest"
REMOTE_SCRIPT

cat <<EOF

    Pushed. Now set these in /etc/sponsor/sponsor.env (needs sudo, so a human):

      MIDNIGHT_TXGEN_BIN=$BIN_DIR/pnyx_txgen
      CIRCLE_ARTIFACTS_DIR=$ART_DIR
      INVITE_AUTHORITY_ROOT=<64 hex characters, generated once and never rotated casually —
                             rotating it orphans every circle that already delegated>

    Generate a root with:  openssl rand -hex 32

    Then restart and check it took:
      ssh $REMOTE sudo systemctl restart sponsor@preprod.service
      ssh $REMOTE journalctl -u sponsor@preprod.service -n 20 --no-pager | grep 'invite minting'
EOF
