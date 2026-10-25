#!/bin/zsh
# One-off: build the 4.3.800-rc.2 images from release/4.3 because upstream has not published them.
export PATH=/opt/homebrew/bin:$PATH
set -u
cd "$HOME/pnyx-midnight/src/midnight-indexer" || exit 1
TAG=4.3.800-rc.2
RUSTV=$(sed -n 's/.*channel = "\(.*\)".*/\1/p' rust-toolchain.toml)
echo "repo $(git rev-parse HEAD) rust $RUSTV"
for svc in chain-indexer wallet-indexer indexer-api; do
  echo "=== building $svc at $(date -u +%FT%TZ)"
  podman build --layers -f "$svc/Dockerfile" --build-arg "RUST_VERSION=$RUSTV" \
    -t "docker.io/midnightntwrk/$svc:$TAG" . || { echo "BUILD FAILED $svc"; exit 1; }
  echo "=== done $svc at $(date -u +%FT%TZ)"
done
echo "ALL BUILDS OK"
podman images --format "{{.Repository}}:{{.Tag}}\t{{.Size}}" | grep "$TAG"
