/**
 * Turning what the wallet knows about a transaction into the connector's `TxStatus`.
 *
 * The decision is here rather than inline because the interesting part is what we **refuse** to say.
 * `confirmed` and `finalized` both *require* an `executionStatus`, and an empty one reads as "nothing
 * failed" — so a case we cannot describe is dropped rather than described wrongly.
 *
 * | what the wallet knows | reported as |
 * |---|---|
 * | handed to the sponsor, not seen on chain | `pending` |
 * | on chain, `SUCCESS` | `confirmed`, `executionStatus` from the segments the indexer named |
 * | on chain, `PARTIAL_SUCCESS`/`FAILURE`, segments named | `confirmed` with those verdicts |
 * | on chain, `FAILURE`, **no** segments named | ⚠️ **omitted** |
 * | on chain, no result reported at all | ⚠️ **omitted** |
 * | past its window, never seen | `discarded` |
 *
 * **`finalized` is never claimed.** Nothing available to this wallet reports finality — the indexer
 * gives a block, not a depth or a checkpoint — so every landed transaction is `confirmed` at most.
 * Reporting `finalized` would be inventing a guarantee.
 *
 * **An empty `executionStatus` on a `SUCCESS` is faithful, not a gap.** The indexer sends no per-segment
 * detail precisely when nothing failed (verified live: `transactionResult.segments` is `null` on a full
 * success), so `{}` says "no segment failed", which is exactly what happened.
 *
 * **The two omitted cases are the ones where that reasoning breaks.** A `FAILURE` with no named segments
 * would become `confirmed` + `{}` — indistinguishable from success. A landed transaction with no result
 * is not `pending` (it is in a block) and cannot be `confirmed` (no status to report). Fewer rows is a
 * dApp reading less; a wrong status is a dApp acting on a lie.
 *
 * @module
 */

import type {ExecutionStatus, HistoryEntry, TxStatus} from '@midnight-ntwrk/dapp-connector-api'

/** One transaction as the wallet holds it, reduced to what the mapping needs. */
export type WalletTransaction = {
  /**
   * The transaction hash, when it has one.
   *
   * `null` for a send still in flight: the ledger gives a hash only for a **bound** transaction and
   * binding happens at the sponsor, so the wallet genuinely has none to report yet.
   */
  readonly hash: string | null
  /** True while the send has been handed over but not matched to a chain row. */
  readonly pending: boolean
  /** True once the wallet has given up waiting — no row will ever appear. */
  readonly abandoned: boolean
  /** What the chain said, when it said anything. */
  readonly outcome?: {
    readonly status: 'SUCCESS' | 'PARTIAL_SUCCESS' | 'FAILURE'
    readonly segments: readonly {readonly id: number; readonly success: boolean}[]
  }
}

const executionStatusOf = (segments: readonly {readonly id: number; readonly success: boolean}[]): ExecutionStatus =>
  Object.fromEntries(segments.map((s) => [s.id, s.success ? 'Success' : 'Failure'] as const))

/**
 * The status to report, or `null` when the wallet cannot describe this transaction faithfully.
 *
 * A `null` is a row the caller drops — and should log, because a silently shorter history is
 * indistinguishable from a shorter one.
 */
export const txStatusOf = (tx: WalletTransaction): TxStatus | null => {
  if (tx.abandoned) return {status: 'discarded'}
  if (tx.pending) return {status: 'pending'}
  if (tx.outcome === undefined) return null
  if (tx.outcome.status === 'FAILURE' && tx.outcome.segments.length === 0) return null
  return {status: 'confirmed', executionStatus: executionStatusOf(tx.outcome.segments)}
}

/**
 * One page of history for the connector, newest first, with undescribable rows dropped.
 *
 * A pending entry has no hash, so it cannot be a `HistoryEntry` at all — the API makes `txHash`
 * required. Those are dropped too: a dApp asking for history is asking what the chain recorded.
 * `onDropped` is called with the reason so the caller can log rather than shorten silently.
 */
export const historyEntriesOf = (
  transactions: readonly WalletTransaction[],
  onDropped?: (reason: string) => void,
): readonly HistoryEntry[] =>
  transactions.flatMap((tx) => {
    if (tx.hash === null) {
      onDropped?.('a send still in flight has no hash to report')
      return []
    }
    const txStatus = txStatusOf(tx)
    if (txStatus === null) {
      onDropped?.(
        `no faithful status for ${tx.hash}: ${tx.outcome === undefined ? 'no result reported' : 'a failure with no named segments'}`,
      )
      return []
    }
    return [{txHash: tx.hash, txStatus}]
  })
