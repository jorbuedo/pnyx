/**
 * Whether a gathering transaction's inputs are gone because *it* was submitted, or
 * because something else spent them.
 *
 * **Why the distinction is not cosmetic.** `spentInputCountOf` answers "are the inputs
 * still there", and both outcomes look identical through it. They mean opposite things:
 *
 *  - Something else spent them — the transaction is dead and has to be rebuilt.
 *  - *This* transaction spent them — it succeeded. There is nothing to rebuild, nothing
 *    to sign, and nothing wrong.
 *
 * Collapsing the two told the person who **built** a transaction that had just landed on
 * chain that "whoever built it will have to build it again", and left it sitting in their
 * pending inbox. That is the state a co-signer is in whenever someone else submits: only
 * the submitting device clears its own record, so every other party keeps a pending review
 * of a transaction that is finished.
 *
 * The chain is the source of truth for this, not a message: a "submitted" notification can
 * be missed, arrive out of order, or come from a party that never actually broadcast.
 *
 * @module
 */

import {TransactionHash} from '@evolution-sdk/evolution'
import type {Decode} from '@evolution-sdk/review/Decode'
import {Tx} from '@pnyx/cardano-core'
import {Effect} from 'effect'
import type {CardanoRail} from '../rail'
import {spentInputCountOf} from './foreign-inputs'

/** What the chain says about a gathering transaction. */
export type EnvelopeChainState =
  /** Inputs still unspent — it can still be signed and submitted. */
  | {readonly kind: 'open'}
  /** This transaction is on chain. It succeeded. */
  | {readonly kind: 'landed'; readonly txHash: string}
  /** The inputs were spent by something else, so it can never be submitted. */
  | {readonly kind: 'superseded'; readonly spentInputs: number}

/**
 * Read the chain's verdict on an envelope.
 *
 * Ordered so the cheap answer comes first: an envelope whose inputs are all unspent is the
 * common case and costs exactly what it did before. Only once inputs are missing is it
 * worth asking whether we are the ones who spent them.
 *
 * ⚠️ **Unknown is never reported as `landed`.** `utxosOfTx` is optional on the provider and
 * can fail, and a backend that cannot answer must leave the transaction reading as it did
 * before this existed — `superseded` — rather than have a failed lookup declare a
 * transaction successful. Claiming a send landed when it did not is the one wrong answer
 * here that costs money.
 */
/**
 * The verdict itself, as a pure decision over three facts. Separated from the reads so the
 * rule — in particular *unknown is never `landed`* — can be tested without a chain.
 */
export const chainVerdict = (params: {
  /** How many of the body's inputs the chain says are gone. */
  readonly spentInputs: number
  /** This body's transaction id, or `null` when it could not be computed. */
  readonly txHash: string | null
  /**
   * How many outputs the chain holds for that id — `null` when nothing could be asked
   * (no provider support, or the lookup failed). **Never treated as zero**: unknown must
   * not report a send as successful.
   */
  readonly producedOutputs: number | null
}): EnvelopeChainState => {
  if (params.spentInputs === 0) return {kind: 'open'}
  if (params.txHash === null || params.producedOutputs === null || params.producedOutputs === 0) {
    return {kind: 'superseded', spentInputs: params.spentInputs}
  }
  return {kind: 'landed', txHash: params.txHash}
}

export const envelopeChainState = (
  rail: CardanoRail,
  bodyHex: string,
): Effect.Effect<EnvelopeChainState, never, Decode> =>
  Effect.gen(function* () {
    const spentInputs = yield* spentInputCountOf(rail, bodyHex)
    if (spentInputs === 0) return chainVerdict({spentInputs: 0, txHash: null, producedOutputs: null})

    // Synchronous and throwing on a body it cannot parse.
    const txHash = yield* Effect.try(() => Tx.bodyHash(bodyHex)).pipe(Effect.orElseSucceed(() => null))
    const lookup = rail.chain.getUtxosOfTransaction
    // A transaction that is on chain produced outputs. Whether those outputs have since been
    // spent themselves is irrelevant — they exist, so the transaction happened, and this is the
    // read that answers "what did tx X create" rather than "what is still live". `null` keeps
    // "could not ask" distinct from "asked, and it is not there".
    const producedOutputs =
      txHash === null || lookup === undefined
        ? null
        : yield* lookup(TransactionHash.fromHex(txHash)).pipe(
            Effect.map((outputs) => outputs.length),
            Effect.orElseSucceed(() => null),
          )
    return chainVerdict({spentInputs, txHash, producedOutputs})
  })
