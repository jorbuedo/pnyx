#!/bin/zsh
# Bring the podman VM and the Midnight indexer(s) up. Started by ai.pnyx.midnight at login.
export PATH=/opt/homebrew/bin:$PATH
set -u
podman machine start pnyx 2>&1 | tail -2 || true
for i in 1 2 3 4 5 6 7 8 9 10; do podman info >/dev/null 2>&1 && break; sleep 5; done
# The read-ahead proxy, started ONLY if chain-indexer is actually pointed at it. It exists to make
# a catch-up walk from genesis finish in hours instead of weeks; at the tip it earns nothing (one
# block per 6 s), costs a 21 GB footprint (measured 2026-10-15) and turns an upstream blip into an
# indexer crash-loop, so `bin/repoint-node.sh` moves the container to the upstream directly once
# the walk is done. Deciding from the container's own env rather than a constant here is what keeps
# boot and the container from disagreeing: hardcoding either answer breaks the other config.
# Match on the script name alone: bun reports the path it was invoked with, so a pattern including
# "bun " misses an absolute-path launch and starts a second proxy that dies on EADDRINUSE.
NODE_URL=$(podman inspect pnyx-chain-indexer-mainnet \
  --format "{{range .Config.Env}}{{println .}}{{end}}" 2>/dev/null \
  | sed -n "s/^APP__INFRA__NODE__URL=//p")
case "$NODE_URL" in
  *host.containers.internal:9999*)
    if ! pgrep -f "readahead-proxy.ts" >/dev/null 2>&1; then
      nohup env PNYX_UPSTREAM_WS=wss://rpc.mainnet.midnight.network PNYX_PROXY_PORT=9999 \
        PNYX_UPSTREAM_CONNS=16 PNYX_MAX_INFLIGHT=1024 PNYX_MISS_CONNS=3 \
        bun "$HOME/pnyx-midnight/readahead-proxy.ts" >> "$HOME/pnyx-midnight/log/proxy.log" 2>&1 &
      echo "readahead proxy started (chain-indexer points at it)"
      sleep 3
    else
      echo "readahead proxy already running"
    fi
    ;;
  *)
    echo "readahead proxy not started (chain-indexer dials ${NODE_URL:-<unknown>} directly)"
    ;;
esac

for c in $(podman ps -a --filter name=idx- --format "{{.Names}}"); do
  podman start "$c" 2>&1 | tail -1
done
podman ps --format "{{.Names}} {{.Status}}"

# The tunnel. cloudflared dials out, so nothing listens on the public internet and the box needs no
# open port. Started here rather than via `cloudflared service install`, which wants root: this
# script already runs from the boot daemon as the owning user.
if ! pgrep -f "cloudflared.*tunnel.*run" >/dev/null 2>&1; then
  nohup cloudflared --no-autoupdate tunnel run --token "$(cat "$HOME/pnyx-midnight/secrets/tunnel-token")" \
    >> "$HOME/pnyx-midnight/log/cloudflared.log" 2>&1 &
  echo "cloudflared started"
else
  echo "cloudflared already running"
fi
