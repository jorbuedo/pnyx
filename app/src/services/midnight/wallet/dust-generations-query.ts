/**
 * How to ask an indexer for a dust address's generation feed, in either shape it serves.
 *
 * Its own module, and pure, because the two shapes differ **only** in how the range is named — the
 * selection sets, the union variants and every field on them are byte-identical across preprod and
 * preview (introspected 2026-08-28). Keeping the naming here means `./dust-indexer.ts` opens one
 * socket per read and neither shape gets its own copy of the query.
 *
 * | | preprod / mainnet | preview |
 * |---|---|---|
 * | arguments | `dustAddress!, startIndex: Int!, endIndex: Int!` | `dustAddress!, blockHash: HexEncoded!, dtimeCutoffHeight: Int!` |
 * | what bounds the answer | the index window the caller asked for | a **snapshot pinned at one block**, always the whole tree |
 *
 * ⚠️ **Under the block anchor the caller's window is not honoured, because there is nowhere to put
 * it.** A block-pinned snapshot is the entire tree at that block. That is a widening, so it is safe
 * for both callers here — each passes `0..tip` and takes a minimum or a set — but a future caller
 * that genuinely needs a sub-range must filter what arrives rather than assume it was filtered.
 *
 * ⚠️ **A block anchor must be recent.** The indexer refuses a block further behind the tip than its
 * `max_snapshot_age` (midnight-indexer #1427), because only recent ledger states stay loadable. The
 * limit is runtime config and appears nowhere in the schema, so the anchor is always taken fresh
 * rather than remembered.
 *
 * @module
 */

import type {DustGenerationsShape} from './dust-indexer-capability'

/** Where the feed is anchored: an index window, or one block's snapshot. */
export type GenerationsAnchor =
  | {readonly kind: 'index-range'; readonly start: number; readonly end: number}
  | {readonly kind: 'block-anchored'; readonly blockHash: string; readonly blockHeight: number}

/** The parts of a `dustGenerations` subscription that depend on the shape. */
export type GenerationsQuery = {
  /** Variable declarations for the operation, without the surrounding parentheses. */
  readonly signature: string
  /** The field's argument list, without the surrounding parentheses. */
  readonly args: string
  readonly variables: Record<string, unknown>
}

/**
 * The shape an anchor is for — so a caller cannot pair a block anchor with an index-range indexer.
 */
export const anchorKindFor = (shape: DustGenerationsShape): GenerationsAnchor['kind'] | null =>
  shape.kind === 'index-range' || shape.kind === 'block-anchored' ? shape.kind : null

/**
 * Name the range for `anchor`.
 *
 * `wantDtimeUpdates` is only read under the block anchor, where suppressing them is an argument
 * rather than a matter of what the caller selects: `dtimeCutoffHeight` is the height **at or below
 * which** owned dtime updates are withheld, so `0` withholds none and the snapshot's own height
 * withholds all of them. Under the index range the feed always carries both variants and the
 * selection set decides, so the flag has nothing to change.
 */
export const generationsQuery = (
  anchor: GenerationsAnchor,
  dustAddress: string,
  wantDtimeUpdates: boolean,
): GenerationsQuery =>
  anchor.kind === 'index-range'
    ? {
        signature: '$addr: DustAddress!, $start: Int, $end: Int',
        args: 'dustAddress: $addr, startIndex: $start, endIndex: $end',
        variables: {addr: dustAddress, start: anchor.start, end: anchor.end},
      }
    : {
        signature: '$addr: DustAddress!, $block: HexEncoded!, $cutoff: Int!',
        args: 'dustAddress: $addr, blockHash: $block, dtimeCutoffHeight: $cutoff',
        variables: {
          addr: dustAddress,
          block: anchor.blockHash,
          cutoff: wantDtimeUpdates ? 0 : anchor.blockHeight,
        },
      }

/** The whole subscription document for `query`, reading `selection` out of the union. */
export const generationsSubscription = (query: GenerationsQuery, selection: string): string =>
  `subscription Gens(${query.signature}) {
  dustGenerations(${query.args}) {
    __typename
${selection}
  }
}`
