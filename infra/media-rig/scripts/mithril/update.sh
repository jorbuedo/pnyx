#!/bin/bash
source ~/pnyx-media/mithril/env.sh
DIGEST="$1"; START="$2"; END="$3"
exec ~/mithril-tools/mithril-client \
  --aggregator-endpoint "$AGGREGATOR_ENDPOINT" \
  cardano-db download "$DIGEST" \
  --backend v2 --start "$START" --end "$END" \
  --download-dir "$HOME/cardano-db/_mithril_new" \
  --genesis-verification-key "$GENESIS_VERIFICATION_KEY"
