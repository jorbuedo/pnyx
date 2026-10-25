#!/bin/zsh
# Repoint chain-indexer at a different node WebSocket, reusing its own CreateCommand as the spec so
# no env or secret is retyped. The two endpoints you ever want:
#
#   repoint-node.sh wss://rpc.mainnet.midnight.network   # direct: the tip-following steady state
#   repoint-node.sh ws://host.containers.internal:9999   # via readahead-proxy.ts, for a walk only
#
# Repointing AT the proxy requires the proxy to be up first, or the indexer spins on a dead port
# (measured 2026-10-11: 127 restarts, 9 hours, every log line clean). Repointing AWAY from it is
# the safe direction and leaves the proxy killable; kill it by pid, never by pgrep pattern.
export PATH=/opt/homebrew/bin:$PATH
set -u
URL=${1:?node websocket url, e.g. wss://rpc.mainnet.midnight.network}
C=${2:-pnyx-chain-indexer-mainnet}

case "$URL" in
  ws://*|wss://*) ;;
  *) echo "refusing: $URL is not a ws:// or wss:// url"; exit 1;;
esac

cmd=$(podman inspect "$C" --format "{{range .Config.CreateCommand}}{{.}} {{end}}" 2>/dev/null) \
  || { echo "no such container $C"; exit 1; }
case "$cmd" in
  *APP__INFRA__NODE__URL=*) ;;
  *) echo "$C has no APP__INFRA__NODE__URL, refusing"; exit 1;;
esac

old=$(podman inspect "$C" --format "{{range .Config.Env}}{{println .}}{{end}}" | sed -n "s/^APP__INFRA__NODE__URL=//p")
if [[ "$old" == "$URL" ]]; then echo "$C already points at $URL, nothing to do"; exit 0; fi

# Height before and after: the only honest progress check. /ready latches 200 and container status
# reads Up through a multi-hour stall, so neither is evidence (measured 2026-10-15, 17 h stuck).
height() { podman exec pnyx-pg-mainnet psql -U indexer -d indexer -tAc "select max(height) from blocks" 2>/dev/null | tr -d " "; }
before=$(height)
echo "=== $C: $old -> $URL (height $before)"

newcmd=${cmd//APP__INFRA__NODE__URL=$old/APP__INFRA__NODE__URL=$URL}
podman rm -f "$C" >/dev/null || exit 1
eval "$newcmd" >/dev/null || { echo "run failed for $C"; exit 1; }

echo "=== waiting 90s for blocks to land"
sleep 90
after=$(height)
podman ps --format "{{.Names}}\t{{.Status}}" | grep -- "${C}"
echo "height $before -> $after"
if [[ -n "$before" && -n "$after" && "$after" -gt "$before" ]]; then
  echo "OK: advancing"
else
  echo "NOT ADVANCING -- check: podman logs --tail 40 $C"
  exit 1
fi
