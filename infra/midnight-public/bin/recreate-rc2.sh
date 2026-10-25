#!/bin/zsh
# Recreate the three indexer containers on a new tag, reusing each one's own CreateCommand as the
# spec so no env or secret is retyped. Usage: recreate-rc2.sh <from-tag> <to-tag>
export PATH=/opt/homebrew/bin:$PATH
set -u
FROM=${1:?from tag}
TO=${2:?to tag}
for c in pnyx-chain-indexer-mainnet pnyx-wallet-indexer-mainnet pnyx-indexer-api-mainnet; do
  cmd=$(podman inspect "$c" --format "{{range .Config.CreateCommand}}{{.}} {{end}}" 2>/dev/null) || { echo "no such container $c"; exit 1; }
  case "$cmd" in
    *":$FROM"*) ;;
    *) echo "$c is not on $FROM, refusing"; exit 1;;
  esac
  newcmd=${cmd//:$FROM/:$TO}
  echo "=== $c -> $TO"
  podman rm -f "$c" >/dev/null || exit 1
  eval "$newcmd" >/dev/null || { echo "run failed for $c"; exit 1; }
done
sleep 5
podman ps --format "{{.Names}}\t{{.Image}}\t{{.Status}}"
