#!/usr/bin/env bash
# Mirror the wallet circuits' proving key material onto the sponsor host.
#
# The host proves the fee balancing in-process (docs/SPONSOR_HOST.md), so it needs the four wallet
# circuits' keys and the KZG SRS on disk. ~22 MB of keys plus whichever SRS the circuits ask for.
#
# **These are not our contract's artifacts.** zswap/{spend,output,sign} and dust/spend are the fee
# machinery and are identical for every deployment, so a contract redeploy does not invalidate this
# directory — nothing here is versioned by contract address.
#
# Run once per box (or after a KEY_MATERIAL_VERSION bump), from the repo:
#   SPONSOR_SSH=sponsor@<host> infra/sponsor-host/fetch-prover-keys.sh
#
# The default source is the bucket the wallet SDK's own key-material provider reads. It is a *dev*
# bucket, which is why this is a one-time mirror at setup rather than a runtime dependency: the
# service reads local files and never reaches out while a user waits. Point SRS_ORIGIN at our own R2
# for the SRS, which we already serve there for the device prover.
set -euo pipefail

REMOTE="${SPONSOR_SSH:?set SPONSOR_SSH, e.g. sponsor@<host>}"
KEYS_DIR="${SPONSOR_KEYS_DIR:-/var/lib/sponsor/prover-keys}"
# Must match KEY_MATERIAL_VERSION in packages/chain-client/src/prover-keys.ts.
VER="${KEY_MATERIAL_VERSION:-9}"
UPSTREAM="${KEY_ORIGIN:-https://midnight-s3-fileshare-dev-eu-west-1.s3.eu-west-1.amazonaws.com}"
SRS_ORIGIN="${SRS_ORIGIN:-https://artifacts.pxkq.uk}"
# Which SRS sizes to mirror. The prover asks by K at proving time, so mirroring the set our artifacts
# bucket serves costs ~11 MB and removes a whole class of "worked until a circuit needed K=15".
SRS_KS="${SRS_KS:-9 13 14 15}"

echo "==> preparing $REMOTE:$KEYS_DIR"
ssh "$REMOTE" "mkdir -p $KEYS_DIR/zswap/$VER $KEYS_DIR/dust/$VER $KEYS_DIR/params"

# Fetched on the box rather than pushed through this machine: it is a straight copy, and the box's
# uplink is not the bottleneck the 400 MB code closure had to work around.
for circuit in zswap/spend zswap/output zswap/sign dust/spend; do
  family="${circuit%%/*}"
  name="${circuit##*/}"
  for ext in prover verifier bzkir; do
    src="$UPSTREAM/$family/$VER/$name.$ext"
    dst="$KEYS_DIR/$family/$VER/$name.$ext"
    echo "    $family/$VER/$name.$ext"
    ssh "$REMOTE" "curl -fsS --retry 3 -o '$dst.part' '$src' && mv '$dst.part' '$dst'"
  done
done

for k in $SRS_KS; do
  echo "    params/bls_midnight_2p$k"
  ssh "$REMOTE" \
    "curl -fsS --retry 3 -o '$KEYS_DIR/params/bls_midnight_2p$k.part' '$SRS_ORIGIN/params/bls_midnight_2p$k' \
     && mv '$KEYS_DIR/params/bls_midnight_2p$k.part' '$KEYS_DIR/params/bls_midnight_2p$k'"
done

# A bad key fails inside the WASM prover with nothing naming the file, so check here where the fix is
# obvious. Only emptiness is checkable: `curl -f` already rejects an error page, the `.part` rename
# means a died-mid-transfer file is never published under its real name, and small is not a smell —
# `zswap/9/sign.bzkir` is legitimately 114 bytes, so any size threshold is a false alarm generator.
echo "==> verifying"
ssh "$REMOTE" "find $KEYS_DIR -type f -empty -printf '    EMPTY %p\n'; find $KEYS_DIR -name '*.part' -printf '    UNFINISHED %p\n'; find $KEYS_DIR -type f | wc -l | xargs printf '    %s files, '; du -sh $KEYS_DIR | cut -f1"

cat <<EOF

Set this in /etc/sponsor/sponsor.env, then restart:

  CHAIN_PROVER_KEYS_DIR=$KEYS_DIR

  ssh $REMOTE 'sudo systemctl restart sponsor.service'
EOF
