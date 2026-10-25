#!/bin/bash
# Long-running media crawl, owned by systemd so a dropped SSH session cannot SIGHUP it.
#
# IPFS only: public gateways first, local kubo last.
#
# fetch.ts is resumable and never re-fetches status='ok', so repeated cycles are safe
# and each one only picks up what is still retryable.
set -u
export PATH="$HOME/.bun/bin:$PATH"

RIG="$HOME/media-rig"
DB="$RIG/data/assets.db"
# $OUT/media is a symlink to /srv/pnyx-media/v1: the crawl writes straight into the
# tree nginx serves, so there is no sync leg and no 40-minute delivery lag.
OUT="$RIG/out"
LOG="$RIG/logs/fetch.log"
IPFS_CONC="${IPFS_CONC:-24}"
SIZE="${SIZE:-256}"
# Newest mints first: coverage is worst where assets are newest, and fresh CIDs are
# still pinned (~33/s, ~100% hit) where the 2021-22 tail is not (0.9/s, 65%).
ORDER="${ORDER:-recent}"
# nginx owns :8080 on this box, so kubo's gateway lives on :8081.
export KUBO_GATEWAY="${KUBO_GATEWAY:-http://127.0.0.1:8081/ipfs/}"

mkdir -p "$(dirname "$LOG")" "$OUT"
say() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$LOG"; }

if [ ! -d "$OUT/media" ]; then
  say "[fatal] $OUT/media is missing — expected a symlink to /srv/pnyx-media/v1"; exit 1
fi

if [ -f "$LOG" ] && [ "$(stat -c%s "$LOG" 2>/dev/null || echo 0)" -gt 268435456 ]; then
  tail -c 33554432 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"; say "[rotate] log truncated"
fi

RETRYABLE="status IS NULL OR status IN ('pending','not-found','timeout','error','gateway-error')"
cycle=0
while true; do
  # The top-up job stops this service while it writes; nothing to coordinate here.
  pending=$(sqlite3 "$DB" "SELECT COUNT(*) FROM asset WHERE $RETRYABLE;" 2>/dev/null || echo "?")
  ok=$(sqlite3 "$DB" "SELECT COUNT(*) FROM asset WHERE status='ok';" 2>/dev/null || echo "?")
  mb=$(sqlite3 "$DB" "SELECT COALESCE(SUM(out_bytes),0)/1048576 FROM asset WHERE status='ok';" 2>/dev/null || echo 0)

  if [ "$pending" = "0" ]; then
    say "[idle] nothing retryable; ok=$ok stored=${mb}MB — sleeping 1h"; sleep 3600; continue
  fi

  cycle=$((cycle+1))
  cd "$RIG/pipeline" || { say "[fatal] no pipeline dir"; sleep 300; continue; }

  say "[cycle $cycle | crawl] retryable=$pending ok=$ok stored=${mb}MB conc=$IPFS_CONC"
  # TOTAL is the denominator for fetch.ts's progress line: it streams in batches and
  # never learns the size of the retryable set, and counting it there would repeat the
  # 10M-row scan this loop just did.
  CONC="$IPFS_CONC" SIZE="$SIZE" KUBO_FIRST=0 ORDER="$ORDER" TOTAL="$pending" bun run fetch.ts "$DB" "$OUT" >> "$LOG" 2>&1 \
    && say "[cycle $cycle | crawl] done" || say "[cycle $cycle | crawl] exited $?"

  sleep 60
done
