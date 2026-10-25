// Whether the sponsor should submit what it just balanced.
//
// `balanceTx` prices the transaction it assembles with the SDK's `feesWithMargin`, which calls the
// ledger's `cost(params, false)` — the dismiss-time rule **disabled**. So the sponsor can balance a
// transaction it is willing to pay for and have the node refuse it anyway, and the only report is a
// `1010: Invalid Transaction: Custom error: N` arriving after submission, decodable only against the
// revision the network happens to be running (codes get retired). `fees(params, true)` runs the
// node's own rule here, before the submit, where the reason is still legible.
//
// This matters most for what the sponsor adds rather than what it was handed: balancing appends dust
// spend actions, and which segment they land in is not established, so the sponsor is capable of
// assembling something it cannot submit.
import {isTransientWalletPanic} from './submission.js'

/**
 * The one method this needs from a balanced transaction.
 *
 * Narrow on purpose: `balanceTx` is typed `unknown`, and a real ledger `Transaction` cannot be
 * constructed in a unit test, so the decision is written against the method it calls rather than
 * against the class. That keeps the rule testable without the WASM.
 */
export type FeeAssessable = {
  fees(params: unknown, enforceTimeToDismiss?: boolean): bigint
}

/**
 * What to do with a balanced transaction before submitting it.
 *
 * | `fees(params, true)` | verdict | consequence |
 * |---|---|---|
 * | returns a fee | `ok` | submit it |
 * | throws, transient WASM panic | `unpriceable` | submit it anyway, and say so |
 * | throws, anything else | `refuse` | do not submit; the reason is the ledger's own |
 *
 * `unpriceable` exists because the ledger WASM occasionally panics inside fee pricing in the window
 * after a landed transaction while the dynamic dust price transitions
 * ({@link isTransientWalletPanic}). Treating that as a refusal would convert a retryable condition
 * into a permanent failure, so the submission proceeds and the existing retry path owns it. The
 * caller must still report it: a pre-check that silently declined to check cannot be told apart from
 * one that passed.
 */
export type DismissBudgetVerdict =
  | {readonly kind: 'ok'; readonly fee: bigint}
  | {readonly kind: 'refuse'; readonly reason: string}
  | {readonly kind: 'unpriceable'; readonly reason: string}

/**
 * Run the node's dismiss-time fee rule against an already-balanced transaction.
 *
 * `params` is the ledger's `LedgerParameters`, passed in rather than read here so this module stays
 * free of the WASM import.
 */
export const assessDismissBudget = (tx: FeeAssessable, params: unknown): DismissBudgetVerdict => {
  let fee: bigint
  try {
    fee = tx.fees(params, true)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    if (isTransientWalletPanic(error)) return {kind: 'unpriceable', reason: detail}
    return {kind: 'refuse', reason: `the node would reject this transaction as assembled (${detail})`}
  }
  return {kind: 'ok', fee}
}
