#!/bin/zsh
# Sample the walk rate and the proxy socket count side by side. The gauge is the proxy own count
# (intent); `established` is lsof (truth). A leak shows as established climbing off the gauge.
export PATH=/opt/homebrew/bin:$PATH
PID=$(pgrep -f "bun readahead-proxy.ts")
N=${1:-6}; GAP=${2:-40}
i=0
while [ $i -lt $N ]; do
  h=$(podman exec pnyx-pg-mainnet psql -U indexer -d indexer -tAc "select max(height) from blocks;" | tr -d " ")
  s=$(lsof -nP -p "$PID" -i -a 2>/dev/null | grep -c ESTABLISHED)
  g=$(grep readahead ~/pnyx-midnight/log/proxy.log | tail -1)
  echo "$(date -u +%H:%M:%S) height=$h established=$s | $g"
  i=$((i+1))
  [ $i -lt $N ] && sleep $GAP
done
