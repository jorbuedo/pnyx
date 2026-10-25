#!/usr/bin/env sh
# podman-compose wrapper that picks the indexer image for this host's architecture.
#
# `indexer-standalone` publishes one architecture per tag rather than a multi-arch manifest: 4.3.5 is
# amd64-only and 4.3.5-arm64 is arm64-only (verified against the registry 2026-07-31). Hard-coding
# either one breaks the other platform's `chain:up`, and this repo does not ship a platform-specific
# dependency without a counterpart.
#
# Detected here rather than left to an env var so neither an Apple-silicon nor an x86_64 contributor
# has to know about it. Override with PNYX_INDEXER_TAG if you need a specific build.
set -eu

if [ -z "${PNYX_INDEXER_TAG:-}" ]; then
  case "$(uname -m)" in
    aarch64 | arm64) PNYX_INDEXER_TAG='4.3.5-arm64' ;;
    *) PNYX_INDEXER_TAG='4.3.5' ;;
  esac
fi
export PNYX_INDEXER_TAG

exec podman-compose -f "$(dirname "$0")/compose.yml" "$@"
