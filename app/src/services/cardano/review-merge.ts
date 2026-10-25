/**
 * Merge the two reviews of one settled transaction.
 *
 * The same transaction has two producers, and neither dominates the other.
 * `reviewCardanoTxFromChain` decodes the bytes, so it alone carries the witness
 * set, scripts, collateral, governance procedures, the CBOR and the phase-2
 * verdict. But a transaction body does not contain its own hash, and it carries
 * `network_id` only as an optional field almost nothing sets — both of which the
 * indexed summary always has.
 *
 * So the rule is the same one `reviewCardanoTxFromChain` already follows
 * internally: **bytes for the structure, the indexed record for what bytes cannot
 * give.** Chain-decoded fields win wherever they exist; the stored review fills
 * gaps and never overwrites.
 *
 * Without this, upgrading a cached summary to the decoded review would silently
 * drop the network row and the transaction id.
 *
 * @module
 */

import type {ReviewedBlock, ReviewedTransaction} from '@pnyx/tx-review'

/** Chain-decoded block fields win; stored fields fill whatever they leave absent. */
const mergeBlock = (
  fromChain: ReviewedBlock | undefined,
  fromStore: ReviewedBlock | undefined,
): ReviewedBlock | undefined => {
  if (fromChain === undefined) return fromStore
  if (fromStore === undefined) return fromChain
  return {...fromStore, ...fromChain}
}

/**
 * The chain-decoded review, completed by the stored one. Returns `fromChain`
 * unchanged when there is nothing stored to complete it with.
 */
export const mergeReviewedTx = (
  fromChain: ReviewedTransaction,
  fromStore: ReviewedTransaction | undefined,
): ReviewedTransaction => {
  if (fromStore === undefined) return fromChain
  const block = mergeBlock(fromChain.block, fromStore.block)
  return {
    ...fromChain,
    // A body carries neither of these; the indexed record carries both.
    ...(fromChain.hash === undefined && fromStore.hash !== undefined ? {hash: fromStore.hash} : {}),
    ...(fromChain.networkId === undefined && fromStore.networkId !== undefined ? {networkId: fromStore.networkId} : {}),
    // These three do come from the chain producer — but only when its indexer
    // call succeeded. Falling back beats losing a date we already had.
    ...(fromChain.timestamp === undefined && fromStore.timestamp !== undefined ? {timestamp: fromStore.timestamp} : {}),
    ...(fromChain.status === undefined && fromStore.status !== undefined ? {status: fromStore.status} : {}),
    ...(block !== undefined ? {block} : {}),
  }
}
