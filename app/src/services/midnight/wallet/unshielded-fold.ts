/**
 * Folding the unshielded feed's frames into a UTxO set — the pure half of reading this rail.
 *
 * Extracted because there are now **two** readers of the same feed and they must agree exactly: the
 * one-shot `syncUnshielded`, which reads the replay and leaves, and the live feed, which holds the
 * socket open. Two hand-written copies of this fold would drift, and the direction they drift in is a
 * balance that disagrees with what a send may spend.
 *
 * Pure, so it is testable without a socket: state in, frame in, state out.
 *
 * @module
 */

import type {IndexedTransactionRef, MidnightActivity} from './midnight-activity'
import {mergeActivityByTransaction, midnightActivityOf} from './midnight-activity'
import {applyUnshieldedEvent, type UnshieldedEvent, type UnshieldedUtxo} from './unshielded-utxo-set'

/** One frame of `unshieldedTransactions`, either a progress marker or a transaction. */
export type UnshieldedFrame = {
  readonly __typename?: string
  readonly highestTransactionId?: number
} & UnshieldedEvent & {
    readonly transaction?: IndexedTransactionRef | null
  }

export type UnshieldedFoldState = {
  readonly utxos: ReadonlyMap<string, UnshieldedUtxo>
  /** Oldest first, unmerged — {@link foldedActivity} does the merge, because it is not idempotent. */
  readonly activity: readonly MidnightActivity[]
  /** The highest id the indexer has named, or `null` while it has named none. */
  readonly highestTransactionId: number | null
  /** The highest id actually folded. Compared against {@link highestTransactionId} for catch-up. */
  readonly lastSeenId: number
  readonly applied: number
  /**
   * Consecutive progress frames carrying a `highestTransactionId` we had already been told, with no
   * transaction folded in between. The indexer's heartbeat, counted — see {@link foldIsCaughtUp}.
   */
  readonly progressRepeats: number
}

/** A fold starting from nothing, or resuming from a cached set and cursor. */
export const emptyFold = (from?: {
  readonly utxos: ReadonlyMap<string, UnshieldedUtxo>
  readonly transactionId: number
}): UnshieldedFoldState => ({
  utxos: from?.utxos ?? new Map(),
  activity: [],
  highestTransactionId: null,
  lastSeenId: from?.transactionId ?? 0,
  applied: 0,
  progressRepeats: 0,
})

/**
 * Apply one frame.
 *
 * ⚠️ **A progress frame is the catch-up signal and it arrives first.** It carries `highestTransactionId`
 * before any transaction, so treating its arrival as "done" would end a sync before a single output was
 * folded — which reads every funded address as empty. It only moves `highestTransactionId`; whether the
 * replay has arrived is {@link foldIsCaughtUp}'s question.
 */
export const foldUnshieldedFrame = (
  state: UnshieldedFoldState,
  frame: UnshieldedFrame,
  address: string,
): UnshieldedFoldState => {
  if (frame.__typename === 'UnshieldedTransactionsProgress') {
    const highest = frame.highestTransactionId ?? state.highestTransactionId
    return {
      ...state,
      highestTransactionId: highest,
      // Repeated only when it tells us nothing new. A first progress frame moves the target, so it does
      // not count — `state.highestTransactionId` is still `null` at that point.
      progressRepeats: highest === state.highestTransactionId ? state.progressRepeats + 1 : 0,
    }
  }
  const projected = midnightActivityOf(frame, address)
  return {
    utxos: applyUnshieldedEvent(state.utxos, frame, address),
    activity: projected === null ? state.activity : [...state.activity, projected],
    highestTransactionId: state.highestTransactionId,
    lastSeenId: frame.transaction?.id ?? state.lastSeenId,
    applied: state.applied + 1,
    // A transaction arrived, so the stream is still delivering and the heartbeat count restarts.
    progressRepeats: 0,
  }
}

/**
 * How many unchanging heartbeats mean the indexer has nothing more to send.
 *
 * Two, not one, and the asymmetry is deliberate: this is a **fallback** for when the primary rule
 * cannot fire, so its cost lands only on the anomalous case. One repeat would also match an indexer
 * that stalled for a single heartbeat *mid-replay*, and declaring catch-up there is the unsafe
 * direction — a send would select from a partial set. Two means roughly a minute of the indexer saying
 * nothing new, which a healthy replay never does.
 */
export const PROGRESS_REPEATS_FOR_DRAINED = 2

/**
 * Whether the replay drained without the primary rule ever being satisfiable.
 *
 * Its own predicate so the caller can say so out loud: reaching catch-up this way means the indexer
 * named an id this address never reached, which is worth a log line rather than a silent success.
 */
export const foldDrainedOnHeartbeat = (state: UnshieldedFoldState): boolean =>
  state.progressRepeats >= PROGRESS_REPEATS_FOR_DRAINED &&
  state.highestTransactionId !== null &&
  state.lastSeenId < state.highestTransactionId

/**
 * Whether the replay has reached the id the indexer named.
 *
 * `true` before the indexer has named anything **only when nothing was folded** — an address with no
 * history is read, not pending. Once frames have arrived without a highest id, the walk is not
 * finished and saying so would strand a caller mid-history.
 *
 * Two rules, and the second exists because the first can be unsatisfiable — see the comment inside.
 */
export const foldIsCaughtUp = (state: UnshieldedFoldState): boolean => {
  if (state.highestTransactionId === null) return state.applied === 0
  if (state.lastSeenId >= state.highestTransactionId) return true
  // ⚠️ **Without this the fold can never catch up, and nothing recovers.** `highestTransactionId` is
  // the id the *indexer* named; it is per-address today, but nothing in the protocol guarantees this
  // address ever reaches it. If it does not, the primary rule above is false for ever: the cache is
  // never written, `settlePendingSends` never runs, and every send waits out `awaitFeedCaughtUp` and
  // is refused. The indexer repeating one unchanged heartbeat is proof it has nothing left to send,
  // which is the same conclusion by a route that cannot stall.
  return foldDrainedOnHeartbeat(state)
}

/**
 * Whether a one-shot reader may stop.
 *
 * Distinct from {@link foldIsCaughtUp} for the progress case: an address with nothing to replay reports
 * `highestTransactionId: 0`, which is a complete answer rather than a cursor to chase.
 */
export const foldShouldStop = (state: UnshieldedFoldState): boolean =>
  state.highestTransactionId === 0 || foldIsCaughtUp(state)

/**
 * The activity a fold produced, merged.
 *
 * ⚠️ Merged, not just collected: the feed yields one event per relevant *part* of a transaction, so a
 * sponsored one — a faucet payout, say — arrives twice and would otherwise be listed twice. Kept out of
 * {@link foldUnshieldedFrame} because merging is not idempotent, so a live feed that merged on every
 * frame would fold already-merged rows into themselves.
 */
export const foldedActivity = (state: UnshieldedFoldState): readonly MidnightActivity[] =>
  mergeActivityByTransaction(state.activity)
