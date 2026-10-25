/**
 * Which sections of a confirmed transaction a wallet may apply.
 *
 * The rule is the wallet specification's, and it is not symmetric: a wallet must apply exactly the
 * sections the ledger accepted. Applying a failed one inserts a coin the chain never created, after
 * which every spend proof is built against a commitment tree the chain does not share — and that
 * surfaces as a rejected transaction long after the sync that caused it.
 *
 * Pure and separate from the driver so it can be tested without an indexer.
 *
 * @module
 */

/** As the indexer reports it (`TransactionResultStatus`). */
export type TransactionResultStatus = 'SUCCESS' | 'PARTIAL_SUCCESS' | 'FAILURE'

export type TransactionResult = {
  readonly status: TransactionResultStatus
  /** Per-segment outcome. The indexer reports these for a partial success; on a full success there is
   * nothing to report, which is why {@link ApplyDecision} has an `'all'` case. */
  readonly segments?: ReadonlyArray<{readonly id: number; readonly success: boolean}> | null
}

/**
 * `skip` — do not touch the wallet. `'all'` — every section. A list — only those fallible segments.
 *
 * The guaranteed section is never named: a transaction that reached a block has it, so it is applied
 * whenever anything is.
 */
export type ApplyDecision =
  | {readonly apply: false}
  | {readonly apply: true; readonly segments: readonly number[] | 'all'}

const SKIP = {apply: false} as const

/**
 * Decide from an indexer transaction result.
 *
 * A `FAILURE` is skipped entirely rather than applied guaranteed-only: that status means the
 * guaranteed section itself failed, so the ledger applied none of it.
 *
 * An unknown status is also skipped, and deliberately: a status this build does not recognise is one
 * whose semantics it cannot honour, and guessing "probably fine" is how a wallet ends up holding coins
 * the chain does not.
 */
export const applyDecision = (result: TransactionResult | null | undefined): ApplyDecision => {
  if (result === null || result === undefined) return SKIP
  switch (result.status) {
    case 'SUCCESS':
      return {apply: true, segments: 'all'}
    case 'PARTIAL_SUCCESS': {
      const succeeded = (result.segments ?? []).filter((s) => s.success).map((s) => s.id)
      // A partial success with no successful fallible segment still applied its guaranteed section,
      // which is where a payment to us most often is.
      return {apply: true, segments: succeeded}
    }
    case 'FAILURE':
      return SKIP
    default:
      return SKIP
  }
}
