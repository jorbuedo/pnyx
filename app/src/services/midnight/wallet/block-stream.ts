/**
 * Reading a range of blocks off the indexer's `blocks` subscription instead of fetching them.
 *
 * ⚠️ **This is the same private walk, not a different sync shape.** The wallet still receives every
 * block and decides locally which outputs are its own; nothing about what the indexer learns changes.
 * What changes is the transport: `Subscription.blocks(offset:)` streams the identical fields the
 * batched query asked for, so one `subscribe` replaces one HTTP request per sixteen blocks.
 *
 * ⚠️ **Why it exists — the HTTP path is rate limited and this one is not.** Measured against preprod
 * 2026-09-14: the indexer allows about **1,158 requests in 179 s** from an address and then answers
 * **403 to everything** — a thirty-byte `{ block { height } }` included — for 20 s to 112 s depending
 * on how deep the drain was. A backfill is exactly the shape that drains it, so the walk died every
 * ~16,500 blocks and no retry schedule fixes that. One subscription spends one request for a whole
 * range. Measured the same day: **23,782 blocks a minute** against ~4,600 for the batched fetch, and a
 * 157,000-block backfill goes from ~40 minutes of stall-and-restart to about six.
 *
 * ⚠️ **A range at a time, deliberately, rather than one socket for the whole walk.** Frames arrive
 * faster than the native wallet can apply them and a WebSocket cannot be told to wait, so anything
 * unread is held in memory — about 1.5 KiB a block. Bounding the subscription to the caller's window
 * bounds that, and keeps the walk's existing promise that a window is the unit of *saving*.
 *
 * Its own module for the reason `block-query.ts` is: importing `shielded-sync.ts` pulls
 * `@pnyx/midnight-native`, and therefore `expo-modules-core`, into a test runner that has no Expo
 * global. Here the collector is the part worth testing directly — order is the correctness.
 *
 * @module
 */

import {BLOCK_FIELDS} from './block-query'
import type {TransactionResult} from './shielded-apply-rule'

/** One block as the subscription delivers it — the same fields {@link BLOCK_FIELDS} asks for. */
export type StreamedBlock = {
  readonly height: number
  readonly zswapMerkleTreeRoot?: string
  readonly transactions?: ReadonlyArray<{
    readonly raw?: string
    readonly transactionResult?: TransactionResult | null
  }>
}

/** What the subscription puts in each `next` payload. */
export type BlocksPayload = {readonly blocks?: StreamedBlock | null}

/**
 * Every block from `fromHeight` onwards, live.
 *
 * ⚠️ **It does not end at a height** — the feed replays history and then stays open for new blocks, so
 * the *caller* stops it. {@link collectBlocks} is what knows where to stop.
 */
export const blocksSubscription = (): string =>
  `${BLOCK_FIELDS}\nsubscription Blocks($height: Int!) { blocks(offset: {height: $height}) { ...B } }`

/** Why a collection ended. `complete` is the only one a caller may advance its cursor across. */
export type CollectionEnd =
  | {readonly kind: 'complete'}
  /** A height arrived that was not the one expected — the chain has a gap we cannot cross. */
  | {readonly kind: 'gap'; readonly expected: number; readonly got: number}

export type Collector = {
  /** Hand it one payload; it says whether the subscription should keep running. */
  readonly accept: (payload: BlocksPayload) => 'continue' | 'stop'
  /** The blocks taken so far, strictly in order. */
  readonly blocks: () => readonly StreamedBlock[]
  /** `undefined` while still collecting. */
  readonly end: () => CollectionEnd | undefined
}

/**
 * Collect `[fromHeight, toHeight]` in order, and stop.
 *
 * ⚠️ **Order is the correctness, not a preference.** The commitment tree is indexed by position, so a
 * block applied out of sequence puts our coins at indices the chain gave to other commitments and every
 * proof built from that tree fails. The subscription delivers in order, and this checks rather than
 * trusts — a frame that is not the expected height ends the collection as a `gap`, exactly as a block
 * the batched query could not answer for stopped the walk.
 *
 * A payload carrying no block is ignored rather than treated as the end: the feed is allowed to say
 * nothing useful, and the timeout in the transport is what bounds real silence.
 */
export const collectBlocks = (fromHeight: number, toHeight: number): Collector => {
  const taken: StreamedBlock[] = []
  let expected = fromHeight
  let ended: CollectionEnd | undefined

  return {
    accept: (payload) => {
      // ⚠️ **Frames keep arriving after `'stop'`.** Unsubscribing does not recall what the socket has
      // already buffered, and the first cut of this kept taking them: windows of 1,013 blocks where
      // 1,000 were asked for. Harmless while they stayed consecutive — and a trap if one did not,
      // since it would turn a finished window's verdict into a `gap` after the fact.
      if (ended !== undefined) return 'stop'
      const block = payload.blocks
      if (block === null || block === undefined) return 'continue'
      if (block.height !== expected) {
        ended = {kind: 'gap', expected, got: block.height}
        return 'stop'
      }
      taken.push(block)
      expected += 1
      if (block.height >= toHeight) {
        ended = {kind: 'complete'}
        return 'stop'
      }
      return 'continue'
    },
    blocks: () => taken,
    end: () => ended,
  }
}
