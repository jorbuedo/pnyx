#!/usr/bin/env bash
# Compile Pnyx's contracts and print the gating numbers the design is bounded by (README, "Measured").
#
# Two targets:
#   identity.compact -> managed/identity   one deployment per identity: row + contact card
#   handle.compact   -> managed/handle     one deployment per claimed name
#   circle.compact   -> managed/circle     one deployment per circle
#   proposal.compact -> managed/proposal   one deployment per proposal
#   payment.compact  -> managed/payment    ONE deployment, global, and unreplaceable
#
# Prereq (one-time, run yourself — downloads + executes the compiler binary):
#   mkdir -p ~/.local/compactc && cd ~/.local/compactc \
#     && curl -sL -o c.zip https://github.com/LFDT-Minokawa/compact/releases/download/compactc-v0.31.1/compactc_v0.31.1_x86_64-unknown-linux-musl.zip \
#     && unzip -o c.zip && chmod +x compactc && ./compactc --version
set -euo pipefail
cd "$(dirname "$0")"

COMPACTC="${COMPACTC:-$HOME/.local/compactc/compactc}"
ZKIR="${ZKIR:-$HOME/.local/compactc/zkir}"

echo "== compactc version =="
"$COMPACTC" --version

build () {
  local src="$1" out="$2"
  echo
  echo "== compile $src -> $out (with ZK key generation) =="
  time "$COMPACTC" "$src" "$out"
}

rm -rf managed
build identity.compact managed/identity
build handle.compact managed/handle
build circle.compact managed/circle
build proposal.compact managed/proposal
build payment.compact managed/payment

# The two name-registry candidates from `docs/CONTRACT_RESULTS.md` -> "Spike 5". Off by default
# because nothing ships them; `harness/names-imt-prove.ts` and `harness/names-registry-onchain.ts`
# need `bench-names-imt-ledger`, so build with BENCH=1 before running either.
if [ "${BENCH:-0}" = "1" ]; then
  build bench/names-imt.compact managed/bench-names-imt
  build bench/names-imt-ledger.compact managed/bench-names-imt-ledger
fi

echo
echo "== K per circuit =="
for f in managed/*/zkir/*.zkir; do
  [ -f "$f" ] || continue
  "$ZKIR" mock-compile -v "$f" 2>/dev/null | head -1 || true
done

echo
echo "== artifact sizes =="
du -sh managed/*/keys 2>/dev/null || true

echo "== done =="
