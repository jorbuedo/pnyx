#!/usr/bin/env bash
# Build the identity-row decoder for the Worker.
#
# Decode-only (`--no-default-features`) so the ledger/zkir/zswap trees are never compiled, plus the
# `worker` feature for the wasm exports and the refuse-randomness handler. `wasm-min` trades speed
# for size, which suits a 0.4 ms decode. Result: ~0.53 MB raw / ~0.125 MB gzipped, against the free
# plan's 3 MB.
#
# The artifact is gitignored: it is a build output, and committing it would churn on every Rust
# change. `wrangler deploy` needs it present, so run this first.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
crate="$here/../../../packages/midnight-native/rust"
out="$here/../wasm/identity-row.wasm"

cargo build --manifest-path "$crate/Cargo.toml" \
  --no-default-features --features worker \
  --target wasm32-unknown-unknown --profile wasm-min

cp "$crate/target/wasm32-unknown-unknown/wasm-min/midnight_native.wasm" "$out"
printf 'identity-row.wasm  %s bytes (%s gzipped)\n' \
  "$(stat -c%s "$out")" "$(gzip -c "$out" | wc -c)"
