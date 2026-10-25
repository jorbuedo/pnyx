/**
 * Reconcile a persisted continuation against the chain before offering to resume it.
 *
 * A continuation records what the wallet *believes* happened. That belief can be wrong in both
 * directions: a leg may have landed without being recorded (a mainnet DUST ceremony persisted
 * `signedSteps: []` while its registration was in a block), and a leg the record still lists as
 * pending may have become unsubmittable because its inputs were spent by something else. Both
 * are answerable from the chain — a leg's transaction id is the hash of the very body the record
 * stores — so the resume surface asks rather than assumes.
 *
 * @module
 */

import {TransactionHash, TransactionInput} from '@evolution-sdk/evolution'
import {Decode} from '@evolution-sdk/review/Decode'
import * as Inspect from '@evolution-sdk/review/Inspect'
import {Tx} from '@pnyx/cardano-core'
import type {CardanoTxPayload, SigningRequest} from '@pnyx/signing-service'
import {Effect} from 'effect'
import type {CardanoRail} from '../rail'
import type {ContinuationRecord} from './record'
import {storedRequests} from './record'

/** What the chain says about one stored leg. */
export type LegState =
  /** Its transaction is already in a block — nothing left to submit. */
  | 'landed'
  /** Not on chain, and its inputs are still unspent. */
  | 'submittable'
  /** Not on chain, and at least one input is gone — it can never be submitted. */
  | 'dead'
  /** The chain could not be consulted, or the body could not be decoded. */
  | 'unknown'

export type ReconcileVerdict = {
  /** Legs the chain shows as already included. */
  readonly landed: number
  /** Index a resume must start from — the first leg that is not already landed. */
  readonly nextIndex: number
  readonly outcome:
    | /** Every leg is on chain; the record is finished and should be dropped. */ 'complete'
    | /** The next leg can still be submitted. */ 'resumable'
    | /** The next leg's inputs are spent; only dismissal is honest. */ 'dead'
    | /** Not enough information — leave the record alone. */ 'unknown'
}

/**
 * The verdict for an ordered leg list. Pure.
 *
 * Legs are a chain: a later one usually spends an earlier one's change, so the resume point is
 * the first leg that has not landed — not the count of landed legs, which would skip a gap.
 */
export const reconcileVerdict = (legs: readonly LegState[]): ReconcileVerdict => {
  if (legs.length === 0) return {landed: 0, nextIndex: 0, outcome: 'complete'}

  const landed = legs.filter((l) => l === 'landed').length
  const nextIndex = legs.findIndex((l) => l !== 'landed')
  if (nextIndex === -1) return {landed, nextIndex: legs.length, outcome: 'complete'}

  const next = legs[nextIndex]
  // 'unknown' is not evidence of anything: a provider outage must not turn a live continuation
  // into a dismissable one, nor invite a resume that cannot work.
  const outcome = next === 'dead' ? 'dead' : next === 'unknown' ? 'unknown' : 'resumable'
  return {landed, nextIndex, outcome}
}

/** A stashed leg, narrowed to the Cardano transaction shape this module can check. */
type CardanoSigningRequest = SigningRequest & {readonly payload: CardanoTxPayload}

const asCardanoRequest = (value: unknown): CardanoSigningRequest | null => {
  const payload = (value as {payload?: CardanoTxPayload} | null)?.payload
  return payload?._tag === 'CardanoTx' && typeof payload.bodyHex === 'string' ? (value as CardanoSigningRequest) : null
}

/** Ask the chain about one leg body. Never fails — an unanswerable leg reads `unknown`. */
const legStateOf = (rail: CardanoRail, bodyHex: string): Effect.Effect<LegState> =>
  Effect.gen(function* () {
    const txId = yield* Effect.try(() => Tx.bodyHash(bodyHex)).pipe(Effect.orElseSucceed(() => null))
    if (txId === null) return 'unknown' as const

    // `getTxInfo` is optional on the chain client. Without it, spent inputs are ambiguous — the
    // spender may be this very leg (landed) or anything else (dead) — and nothing here can tell
    // the two apart, so such a leg stays `unknown` rather than being guessed either way.
    const txInfo = rail.chain.getTxInfo
    const canDetectLanded = txInfo !== undefined
    if (txInfo !== undefined) {
      const onChain = yield* txInfo([TransactionHash.fromHex(txId)]).pipe(Effect.orElseSucceed(() => null))
      if (onChain === null) return 'unknown' as const
      if (onChain.length > 0) return 'landed' as const
    }

    const decoded = yield* Inspect.txBody(bodyHex).pipe(
      Effect.provideService(Decode, rail.decode),
      Effect.orElseSucceed(() => null),
    )
    if (decoded === null) return 'unknown' as const

    const refs = decoded.body.inputs.map(
      (i) =>
        new TransactionInput.TransactionInput({
          transactionId: TransactionHash.fromHex(i.txHashHex),
          index: BigInt(i.index),
        }),
    )
    if (refs.length === 0) return 'unknown' as const

    // ⚠️ `resolveOutRefs`, never `getUtxosByOutRef`. The verdict below turns on telling
    // `spent === false` from `spent === undefined`, and the filtered read reports neither: a
    // consumed output is simply absent from it, so every leg whose inputs are live would read
    // `unknown` and no continuation could ever be resumed.
    const resolve = rail.chain.resolveOutRefs
    if (resolve === undefined) return 'unknown' as const
    const resolved = yield* resolve(refs).pipe(Effect.orElseSucceed(() => null))
    if (resolved === null) return 'unknown' as const

    // An input the backend cannot resolve at all is gone (pruned or never existed); one it
    // resolves as spent is equally gone. Only `spent === false` is positive evidence, so a
    // backend that reports no flag leaves the leg unknown rather than optimistically resumable.
    const gone = resolved.length < refs.length || resolved.some((o) => o.spent === true)
    if (gone) return canDetectLanded ? ('dead' as const) : ('unknown' as const)
    return resolved.every((o) => o.spent === false) ? ('submittable' as const) : ('unknown' as const)
  })

export type ContinuationReconciliation = ReconcileVerdict & {
  readonly legs: readonly LegState[]
  /**
   * The legs a resume should submit — sliced at the reconciled `nextIndex`, not at the record's
   * own `currentStepIndex`, which is exactly the field that can be wrong.
   */
  readonly remaining: readonly SigningRequest[]
}

/**
 * Reconcile `record` against the chain.
 *
 * Reads the leg bodies the record stashed; a record with no reconstructable payload cannot be
 * checked and reads `unknown`.
 */
export const reconcileContinuation = (
  rail: CardanoRail,
  record: ContinuationRecord,
): Effect.Effect<ContinuationReconciliation> =>
  Effect.gen(function* () {
    const stashed = storedRequests(record)
    if (stashed === null) return {landed: 0, nextIndex: 0, outcome: 'unknown' as const, legs: [], remaining: []}

    const requests = stashed.map(asCardanoRequest)
    const legs = yield* Effect.forEach(requests, (request) =>
      request === null ? Effect.succeed('unknown' as const) : legStateOf(rail, request.payload.bodyHex),
    )
    const verdict = reconcileVerdict(legs)
    const remaining = requests.slice(verdict.nextIndex).filter((r): r is CardanoSigningRequest => r !== null)
    return {...verdict, legs, remaining}
  })
