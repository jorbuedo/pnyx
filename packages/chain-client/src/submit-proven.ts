// The balance + submit + confirm core of the on-device-proving rail, split from client.ts so it
// can be driven directly (harness/submit-proven-local.ts, e2e) with the same providers used to
// build + prove a transaction — no second wallet. client.ts wraps this in the FIFO queue +
// coin-race guard; here is just the seam: an already-proven, unbound tx → balanced → submitted →
// confirmed.
import {LedgerParameters, Transaction} from '@midnight-ntwrk/midnight-js-protocol/ledger'
import {assessDismissBudget, type FeeAssessable} from './dismiss-budget.js'
import {isTxSuccess, PROVEN_TX_MARKERS} from './proven.js'
import {SPONSORSHIP_REFUSAL_PREFIX} from './sponsorship.js'
import {submitRejectionError} from './submit-failure.js'

/** The provider trio balanceAndSubmitProven needs (a subset of the midnight-js providers). */
export type ProvenSubmitProviders = {
  readonly walletProvider: {balanceTx(tx: unknown, ttl?: Date): Promise<unknown>}
  readonly midnightProvider: {submitTx(tx: unknown): Promise<string>}
  readonly publicDataProvider: {
    watchForTxData(txId: string): Promise<{txId: string; blockHeight: number; status: string}>
  }
}

export type ProvenTxResult = {txId: string; blockHeight: string}

/**
 * Deserialize an already-proven, unbound transaction (`Transaction<signature, proof, pre-binding>`)
 * and drive it to confirmation via the sponsor wallet: `balanceTx` binds the DUST fee (no
 * re-proving), `submitTx` sends it, `watchForTxData` waits for the block. Throws with a clear
 * message on a malformed payload or a non-success on-chain status.
 *
 * Between balancing and submitting it re-prices the transaction with the dismiss-time rule enforced
 * and **refuses** rather than submitting one the node would reject — see `dismiss-budget.ts`. Every
 * verdict reaches `log`: a pre-check that logs nothing on the happy path cannot be told apart from
 * one that never shipped.
 */
export const balanceAndSubmitProven = async (
  providers: ProvenSubmitProviders,
  txBytes: Uint8Array,
  log: (message: string) => void = () => {},
): Promise<ProvenTxResult> => {
  const [markerS, markerP, markerB] = PROVEN_TX_MARKERS
  let unbound: unknown
  try {
    unbound = Transaction.deserialize(markerS, markerP, markerB, txBytes)
  } catch (error) {
    throw new Error(
      `submitProven: could not deserialize a proven-unbound transaction (expected ${PROVEN_TX_MARKERS.join(
        '/',
      )}): ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const finalized = await providers.walletProvider.balanceTx(unbound)
  // Balancing priced this with the dismiss-time rule off, so ask once more with it on: a refusal here
  // carries the ledger's reason, where the same failure after `submitTx` arrives as an opaque
  // `Custom error: N` that has to be decoded against whatever revision the node runs.
  const verdict = assessDismissBudget(finalized as FeeAssessable, LedgerParameters.initialParameters())
  if (verdict.kind === 'refuse') {
    throw new Error(`${SPONSORSHIP_REFUSAL_PREFIX}${verdict.reason}`)
  }
  if (verdict.kind === 'unpriceable') {
    log(`submitProven: could not price the balanced transaction, submitting anyway: ${verdict.reason}`)
  }
  if (verdict.kind === 'ok') {
    log(`submitProven: the node's own fee rule accepts this transaction (${verdict.fee})`)
  }
  const txId = await providers.midnightProvider.submitTx(finalized).catch((error: unknown) => {
    // ⚠️ Rethrown with the reason attached, because nothing downstream can recover it: the SDK wraps
    // every node rejection as `SubmissionError('Transaction submission error')` with the truth in a
    // field, and `runPromise` flattens that to the summary alone. The sponsor then records the
    // summary, and Cloudflare replaces its 502 body — so a failure here reached the user as
    // "error code: 502" and was unrecoverable from any log.
    const rejection = submitRejectionError(error)
    log(rejection.message)
    throw rejection
  })
  const data = await providers.publicDataProvider.watchForTxData(txId)
  if (!isTxSuccess(String(data.status))) {
    throw new Error(`submitProven: transaction ${txId} applied with status ${String(data.status)}`)
  }
  return {txId: String(data.txId), blockHeight: String(data.blockHeight)}
}
