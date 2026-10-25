/**
 * What a shielded walk reads out of a block.
 *
 * Its own module for the same reason `sync-window.ts` is: importing `shielded-sync.ts` pulls
 * `@pnyx/midnight-native`, and therefore `expo-modules-core`, into a test runner that has no Expo
 * global. The fields are a pure string and their shape is what the indexer's limits are spent on, so it
 * is worth being able to test directly.
 *
 * ⚠️ **These fields are now asked for over a subscription, not fetched.** The indexer's HTTP endpoint
 * enforces three limits, all measured 2026-09-14:
 *
 * | limit | how it answers |
 * |---|---|
 * | **complexity** | HTTP **200**, `data: null`, `"Query is too complex."` in `errors` — twenty aliased `block` selections was the ceiling |
 * | **request size**, 8 KiB | HTTP **403** with nginx's HTML page: 8,012 B answers 200, 8,512 B does not |
 * | **rate**, ~1,158 requests in 179 s | HTTP **403** to *everything* from the address, for 20 s to 112 s |
 *
 * The complexity one is the dangerous shape: a caller that checks only the HTTP status reads it as *an
 * empty range* and then advances its cursor over blocks it never looked at. `shielded-sync.ts`'s
 * `query` raises on `errors` precisely so that cannot happen.
 *
 * The rate one is what ended block *fetching*. A backfill is the shape that drains the budget, and no
 * retry schedule outlasts a two-minute lockout — so the walk streams blocks from
 * `Subscription.blocks(offset:)` instead (`block-stream.ts`), spending one request for a whole range.
 * The limits above still bind every other read `shielded-sync.ts` makes over HTTP — the tip, the
 * collapsed update, a block's timestamp — which are one request each and nowhere near any of them.
 *
 * @module
 */

/**
 * What one block contributes to the walk.
 *
 * `raw` is the whole serialized transaction — the only form the native wallet can apply, since it is
 * the ledger's own encoding. `transactionResult` decides which sections of it may be applied.
 *
 * ⚠️ The transaction **hash** was queried here for a long time and read by nothing. An unread field is
 * budget spent on nothing — it cost complexity when these were batched, and costs bandwidth per block
 * now that they are streamed.
 */
export const BLOCK_FIELDS = `fragment B on Block {
  height
  zswapMerkleTreeRoot
  transactions {
    raw
    ... on RegularTransaction {
      transactionResult {
        status
        segments { id success }
      }
    }
  }
}`
