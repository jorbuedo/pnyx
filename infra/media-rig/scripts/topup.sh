#!/bin/bash
# New entries: pull the immutable chunks minted since the last run, extract them, and
# ingest the new assets into assets.db so the crawl has something to fetch.
#
# Nothing scheduled this before — the corpus froze the day after every chain top-up and
# sat 47 days stale before anyone noticed. The systemd timer alongside this file is the
# whole fix; everything here is the mechanical part the repo README already described.
#
# Cheap by construction: Mithril's v2 backend restores an immutable RANGE, so a daily
# run downloads ~4 chunks (~100 MB), not the 235 GB full snapshot.
set -uo pipefail
export PATH="$HOME/.bun/bin:$PATH"

RIG="$HOME/media-rig"
DB="$RIG/data/assets.db"
STATE="$RIG/data/topup.state"
WORK="$RIG/work"
LOG="$RIG/logs/topup.log"
FETCH_UNIT="pnyx-mediafetch.service"

mkdir -p "$(dirname "$LOG")" "$RIG/data"
say() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$LOG"; }

LOCK="$RIG/.topup.lock"
if ! mkdir "$LOCK" 2>/dev/null; then say "[skip] a top-up is already running"; exit 0; fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

# shellcheck source=/dev/null
if ! source "$RIG/scripts/mithril/env.sh" 2>/dev/null; then
  say "[fatal] cannot read scripts/mithril/env.sh — no aggregator or genesis key"; exit 1
fi

read_state() { python3 - "$STATE" "$1" <<'PY'
import json, sys
try:
    print(json.load(open(sys.argv[1]))[sys.argv[2]])
except Exception:
    print(0)
PY
}
LAST_IMM=$(read_state last_immutable)
LAST_SLOT=$(read_state last_slot)
if [ "$LAST_IMM" -le 0 ]; then
  say "[fatal] $STATE has no last_immutable — seed it before the first run"; exit 1
fi

LATEST=$(mithril-client --aggregator-endpoint "$AGGREGATOR_ENDPOINT" \
           cardano-db snapshot list --backend v2 --json 2>>"$LOG" \
         | python3 -c 'import json,sys; print(max(s["beacon"]["immutable_file_number"] for s in json.load(sys.stdin)))' 2>>"$LOG")
if ! [ "${LATEST:-0}" -gt 0 ] 2>/dev/null; then
  say "[error] could not read the aggregator's latest immutable number — leaving state at $LAST_IMM"; exit 1
fi
if [ "$LATEST" -le "$LAST_IMM" ]; then
  say "[idle] nothing new: aggregator at $LATEST, we hold $LAST_IMM"; exit 0
fi

# Re-download chunks we already hold. The overlap PROVES there is no hole (the probe
# reports first_slot, which must land at or below the slot we stopped at) instead of
# trusting chunk arithmetic, and ingest is an upsert so it costs nothing.
#
# ONE chunk of overlap was not enough. On 2026-10-13 the state recorded
# last_immutable=9151 while the corpus only reached slot 197653877, which sits a third
# of a chunk inside 9150 — so a pass starting at 9151 began 7,808 slots past the corpus
# end and the guard below refused it, correctly, every night for five nights. A chunk is
# ~14 MB and ~21,400 slots, so a few chunks of overlap costs little and absorbs a last
# chunk that was still being written when we read it.
OVERLAP="${OVERLAP:-3}"
MAX_ATTEMPTS="${MAX_ATTEMPTS:-3}"

attempt=1
while :; do
  START=$((LAST_IMM - OVERLAP + 1))
  [ "$START" -lt 1 ] && START=1
  say "[start] immutable $START..$LATEST ($((LATEST - LAST_IMM)) new chunks, overlap $OVERLAP, attempt $attempt)"

  rm -rf "$WORK"; mkdir -p "$WORK"
  if ! mithril-client --aggregator-endpoint "$AGGREGATOR_ENDPOINT" \
        cardano-db download latest --backend v2 --start "$START" --end "$LATEST" \
        --download-dir "$WORK" \
        --genesis-verification-key "$GENESIS_VERIFICATION_KEY" >>"$LOG" 2>&1; then
    say "[error] mithril download failed — state unchanged at $LAST_IMM"; exit 1
  fi

  IMM=$(find "$WORK" -type d -name immutable | head -1)
  if [ -z "$IMM" ] || [ -z "$(ls -A "$IMM" 2>/dev/null)" ]; then
    say "[error] no immutable chunks under $WORK after download — state unchanged"; exit 1
  fi
  say "[downloaded] $(ls "$IMM"/*.chunk 2>/dev/null | wc -l) chunks, $(du -sh "$IMM" | cut -f1)"

  P="$RIG/extract-probe/target/release"
  if ! "$P/probe" "$IMM" "$RIG/data/meta721.tail.jsonl" > "$WORK/probe.json" 2>>"$LOG"; then
    say "[error] probe failed — state unchanged"; exit 1
  fi
  FIRST_SLOT=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["first_slot"])' "$WORK/probe.json" 2>>"$LOG")
  NEW_LAST_SLOT=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["last_slot"])' "$WORK/probe.json" 2>>"$LOG")

  if [ "$LAST_SLOT" -le 0 ] || [ "${FIRST_SLOT:-0}" -le "$LAST_SLOT" ]; then
    break
  fi

  # A hole is recoverable by looking further back, so widen and retry rather than
  # failing every night until someone reads the log. Five nights were lost to exactly
  # that: the guard was right, nothing acted on it.
  if [ "$attempt" -ge "$MAX_ATTEMPTS" ]; then
    say "[fatal] HOLE: pass starts at slot $FIRST_SLOT, corpus ends at $LAST_SLOT, still unclosed after $attempt attempts (overlap $OVERLAP) — nothing ingested"
    exit 1
  fi
  say "[hole] pass starts at slot $FIRST_SLOT but the corpus ends at $LAST_SLOT — widening overlap $OVERLAP -> $((OVERLAP * 3)) and retrying"
  OVERLAP=$((OVERLAP * 3))
  attempt=$((attempt + 1))
done

say "[extracted] slots $FIRST_SLOT..$NEW_LAST_SLOT, $(wc -l < "$RIG/data/meta721.tail.jsonl") 721-records"

if ! "$P/cip68" "$IMM" "$RIG/data/cip68.tail.jsonl" >> "$LOG" 2>&1; then
  say "[warn] cip68 extract failed — continuing with 721 only"
fi

# reconcile/ingest take the write lock for minutes; the crawl holds it almost
# continuously. Stop it rather than fight it — fetch.ts is resumable by design.
RESTART=no
if systemctl is-active --quiet "$FETCH_UNIT"; then
  sudo -n systemctl stop "$FETCH_UNIT" && RESTART=yes || say "[warn] could not stop $FETCH_UNIT — ingesting against a live writer"
fi
restart_fetch() { [ "$RESTART" = yes ] && { sudo -n systemctl start "$FETCH_UNIT" && say "[resumed] $FETCH_UNIT" || say "[error] FAILED to restart $FETCH_UNIT — the crawl is DOWN"; }; }
trap 'restart_fetch; rmdir "$LOCK" 2>/dev/null' EXIT

BEFORE=$(sqlite3 "$DB" "SELECT COUNT(*) FROM asset;" 2>>"$LOG")
cd "$RIG/pipeline" || { say "[fatal] no pipeline dir"; exit 1; }
if ! bun run reconcile.ts "$RIG/data/meta721.tail.jsonl" "$DB" >>"$LOG" 2>&1; then
  say "[error] reconcile failed — state unchanged at $LAST_IMM"; exit 1
fi
if ! bun run ingest-cip68.ts "$RIG/data/cip68.tail.jsonl" "$DB" >>"$LOG" 2>&1; then
  say "[warn] ingest-cip68 failed — 721 rows are in, CIP-68 rows are not"
fi
if ! bun run fixup-resolve.ts "$DB" >>"$LOG" 2>&1; then
  say "[warn] fixup-resolve failed — some rows may keep scheme 'other'/'none'"
fi
AFTER=$(sqlite3 "$DB" "SELECT COUNT(*) FROM asset;" 2>>"$LOG")

# Record the highest chunk actually ON DISK, not $LATEST. Recording what we asked for is
# how the state drifted ahead of the corpus in the first place: the aggregator's latest
# immutable number can name a chunk a range restore does not deliver complete, and the
# next run then started past its own data.
COVERED=$(ls "$IMM"/*.chunk 2>/dev/null | sed 's#.*/##; s#\.chunk$##' | sort -n | tail -1 | sed 's/^0*//')
COVERED=${COVERED:-0}
if [ "$COVERED" -le 0 ]; then
  say "[error] could not read a chunk number off $IMM — state unchanged at $LAST_IMM"; exit 1
fi

python3 - "$STATE" "$COVERED" "$NEW_LAST_SLOT" <<'PY'
import json, sys
json.dump({"last_immutable": int(sys.argv[2]), "last_slot": int(sys.argv[3])}, open(sys.argv[1], "w"))
PY
say "[done] +$((AFTER - BEFORE)) new assets (corpus $BEFORE -> $AFTER), state now immutable=$COVERED slot=$NEW_LAST_SLOT"
rm -rf "$WORK"
