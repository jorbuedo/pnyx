#!/usr/bin/env bash
# Push the sponsor host's runtime tree, verify it boots, restart the router and every network's wallet.
#
# The box never runs `bun install` (docs/SPONSOR_HOST.md), so this pushes a subset of a known-good local
# node_modules — see closure.ts for why subsetting beats reinstalling.
#
# Usage:  SPONSOR_SSH=sponsor@<host> infra/sponsor-host/push.sh [--wipe]
#
# SPONSOR_UNITS overrides which units are restarted; the default is the router plus the three networks.
# A unit that is not installed is skipped with a line rather than failing the push, so this works on a
# host part-way through the migration. `SPONSOR_UNITS=` (empty) restarts nothing — push the code, move the
# units by hand.
#
# Use the provider's hostname rather than the IP: it is the name in known_hosts, and an unknown host key turns
# a non-interactive push into either a failure or a blindly accepted fingerprint.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REMOTE="${SPONSOR_SSH:?set SPONSOR_SSH, e.g. sponsor@<host>}"
REMOTE_DIR="${SPONSOR_DIR:-/opt/sponsor}"
WIPE="${1:-}"

manifest="$(mktemp)"
trap 'rm -f "$manifest"' EXIT

echo "==> computing the runtime closure"
bun "$REPO_ROOT/infra/sponsor-host/closure.ts" "$REPO_ROOT" > "$manifest"

if [[ "$WIPE" == "--wipe" ]]; then
  # rsync --delete cannot prune against a --files-from manifest, so removing stale packages after a
  # dependency drop means clearing the tree. Safe: everything here is pushed, no state lives in it.
  echo "==> wiping $REMOTE_DIR"
  ssh "$REMOTE" "rm -rf ${REMOTE_DIR:?}/node_modules ${REMOTE_DIR:?}/packages ${REMOTE_DIR:?}/services"
fi

echo "==> pushing to $REMOTE:$REMOTE_DIR"
ssh "$REMOTE" "mkdir -p $REMOTE_DIR"
# -r is explicit: --files-from cancels the recursion that -a would otherwise imply, and the manifest
# lists package directories. --links keeps node_modules/@pnyx/* pointing into packages/.
#
# -z is not optional in practice: the payload is ~400 MB of JS/TS/JSON, which compresses several times
# over, and the first push measured ~1 Mbit/s of uplink. --partial so an interrupted run resumes the file
# it was mid-way through rather than re-sending it.
rsync -a -r --links -z --partial --info=stats1 --files-from="$manifest" "$REPO_ROOT/" "$REMOTE:$REMOTE_DIR/"

# The real verification. Every static import is resolved before the module body runs, so a tree with a
# missing package fails here instead of at the next service restart. With no SPONSOR_TOKEN in an ssh
# environment it then exits before constructing a wallet — safe to run against a live host.
#
# Run it from the state dir with an absolute path, exactly as the unit does: importing testkit-js writes a
# log file relative to CWD, and doing it from $REMOTE_DIR would litter the code tree on every push.
echo "==> verifying the import graph on the box"
# Both entry points, because they import different trees: the router pulls no wallet, no ledger and no
# prover, so a package missing only from the wallet's closure would pass a router-only check and fail at
# the next restart. Each refuses on the missing token before constructing anything.
for entry in sponsor-server sponsor-router; do
  output="$(ssh "$REMOTE" "cd /var/lib/sponsor && bun $REMOTE_DIR/services/content/src/$entry.ts 2>&1" || true)"
  if [[ "$output" != *"SPONSOR_TOKEN is required"* ]]; then
    echo "FAILED — the pushed tree does not load $entry:" >&2
    echo "$output" >&2
    exit 1
  fi
  echo "    $entry import graph OK"
done

echo "==> restarting the sponsor units"
# The .service suffix is load-bearing: the deploy user's sudoers entry matches the literal command line.
#
# `is-active` is not a health check. It exits 3 while a unit is `activating`, and a crash-looping unit is
# briefly `active (running)` between automatic restarts — so a naive check both false-fails and
# false-passes. NRestarts is the honest signal: it moves only on a crash, never on an explicit restart.
# ⚠️ `${VAR-default}`, not `${VAR:-default}`: an explicitly **empty** SPONSOR_UNITS must mean "restart
# nothing", which is what a cutover needs — push the code first, then move the units by hand. With `:-`
# an empty value fell through to the default list and started the router on a port the old single-network
# unit still held (EADDRINUSE, 2026-08-28).
UNITS="${SPONSOR_UNITS-sponsor-router.service sponsor@preview.service sponsor@preprod.service sponsor@mainnet.service}"

state_of() {
  ssh "$REMOTE" "systemctl show -p ActiveState --value $1; systemctl show -p SubState --value $1; systemctl show -p NRestarts --value $1" | tr '\n' ' '
}

installed() { ssh "$REMOTE" "systemctl cat $1 >/dev/null 2>&1"; }

# Restarted one at a time and checked one at a time. A single 30s window shared by four units would let a
# unit that crashed at second 3 look fine because another was still starting.
for unit in $UNITS; do
  if ! installed "$unit"; then
    echo "    $unit is not installed on this host — skipped"
    continue
  fi
  read -r _ _ restarts_before <<<"$(state_of "$unit")"
  ssh "$REMOTE" "sudo systemctl restart $unit"

  # Watch for 30s. A cold dust sync takes far longer, but Type=simple goes active as soon as exec
  # succeeds, so a unit healthy at 30s is one whose imports, environment and seed all loaded.
  deadline=$((SECONDS + 30))
  while :; do
    read -r state sub restarts <<<"$(state_of "$unit")"
    if [[ "$restarts" != "$restarts_before" ]]; then
      echo "FAILED — $unit crashed and was restarted ($restarts_before -> $restarts):" >&2
      ssh "$REMOTE" "journalctl -u $unit -n 40 --no-pager" >&2
      exit 1
    fi
    if [[ "$state" == "active" && "$sub" == "running" ]] && (( SECONDS >= deadline )); then break; fi
    if (( SECONDS >= deadline )); then
      echo "FAILED — $unit is $state ($sub) after 30s:" >&2
      ssh "$REMOTE" "journalctl -u $unit -n 40 --no-pager" >&2
      exit 1
    fi
    sleep 5
  done
  echo "    $unit active (running), no crash in the first 30s"
done

echo
echo "    A wallet with no dust-state snapshot syncs for ~35 min before it answers anything but 503."
echo "    Which networks are actually up, in one call:"
echo "      ssh $REMOTE curl -s localhost:3400/health | jq"
echo "    One network's log:"
echo "      ssh $REMOTE journalctl -fu sponsor@preprod.service"
