#!/bin/bash
# One screen of truth for the rig. The DB is authoritative — fetch.log's counters are
# per-run and lag it.
set -uo pipefail
RIG="$HOME/media-rig"
DB="$RIG/data/assets.db"
Q() { sqlite3 -cmd ".timeout 20000" "$DB" "$1"; }

echo "== corpus =="
Q "SELECT printf('%d banked / %d assets (%.1f%%)', SUM(status='ok'), COUNT(*), 100.0*SUM(status='ok')/COUNT(*)) FROM asset;"
echo
echo "== status buckets =="
Q "SELECT printf('%-14s %d', COALESCE(status,'(null)'), COUNT(*)) FROM asset GROUP BY status ORDER BY 1 DESC;" | sort -k2 -rn
echo
echo "== banked by mint year =="
Q "SELECT printf('%s  %7d/%-7d  %5.1f%%', strftime('%Y', datetime(1596059091 + (mint_slot - 4492800),'unixepoch')), SUM(status='ok'), COUNT(*), 100.0*SUM(status='ok')/COUNT(*)) FROM asset WHERE mint_slot IS NOT NULL GROUP BY 1 ORDER BY 1;"
echo
echo "== corpus edge =="
echo -n "newest mint: "; Q "SELECT datetime(1596059091 + (MAX(mint_slot) - 4492800),'unixepoch') FROM asset;"
echo -n "top-up state: "; cat "$RIG/data/topup.state" 2>/dev/null || echo "(none)"
echo
echo "== services =="
for u in nginx cloudflared pnyx-mediafetch pnyx-kubo; do printf '%-18s %s\n' "$u" "$(systemctl is-active $u 2>/dev/null)"; done
printf '%-18s %s\n' "pnyx-topup.timer" "$(systemctl is-active pnyx-topup.timer 2>/dev/null)"
systemctl list-timers pnyx-topup.timer --no-pager 2>/dev/null | sed -n 2p
echo
echo "== disk / serving =="
df -h / | tail -1
echo -n "files on disk: "; find /srv/pnyx-media/v1 -name '*.webp' | wc -l
echo -n "edge check:    "; curl -s -o /dev/null -w '%{http_code} %{size_download}B %{content_type}\n' \
  "https://media.pxkq.uk/$(Q "SELECT fingerprint FROM asset WHERE status='ok' ORDER BY rowid DESC LIMIT 1;")/256.webp"
echo
echo "== last crawl lines =="
tail -3 "$RIG/logs/fetch.log" 2>/dev/null
