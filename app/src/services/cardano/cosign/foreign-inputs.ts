/**
 * Resolving the inputs of a co-signed transaction that this wallet does not own.
 *
 * A review resolves inputs from `rail.spendableUtxos`, which is *this* wallet's coins. That
 * is right for an ordinary send, where every input is ours, and wrong for every transaction
 * co-signing exists to handle: a multiparty body spends one party's coins per party, and a
 * multisig body imported from another tool spends none of ours at all.
 *
 * The consequence is not a missing detail, it is a **false statement on the last screen
 * before a signature**. An unresolved input contributes nothing to the wallet's net, so the
 * other party's *return* — an ordinary output — reads as money arriving from nowhere.
 * Measured on the first co-funded transaction to reach a chain: the composer's review
 * announced "+10,192.429399 tADA" to the co-funder's address, whose true net was −3, and the
 * co-funder's review announced "+72.820463 tADA" to the composer's, whose true net was
 * −5.179537. Each party read their own side correctly and every other party's as a windfall.
 *
 * **The envelope is not the source.** It would be the cheap fix — the builder resolved these
 * outpoints already, so it could simply write them down — and it would mean the sender of a
 * transaction gets to describe the coins it spends to the person deciding whether to sign
 * it. A crafted envelope could understate an input and make a review look benign. So the
 * outpoints come from the body, which is what gets signed, and their values come from the
 * chain.
 *
 * Which leaves the wallet's own coins resolved from the wallet's own view, ahead of anything
 * fetched: first-hand, and it keeps `isVirtual` (a pending parent) and the other things a
 * UTxO set knows that an indexer does not.
 *
 * @module
 */

import {
  Bytes,
  Address as EvolutionAddress,
  type UTxO as EvolutionUTxO,
  TransactionHash,
  TransactionInput,
} from '@evolution-sdk/evolution'
import {TxHashHex} from '@evolution-sdk/review/Brands'
import type {Decode} from '@evolution-sdk/review/Decode'
import * as Inspect from '@evolution-sdk/review/Inspect'
import type {ResolvedInput} from '@pnyx/tx-review'
import {Effect} from 'effect'
import {logger} from '../../../logger'
import type {CardanoRail} from '../rail'

/** An outpoint as Evolution's provider takes it. */
const inputOf = (ref: Outpoint): TransactionInput.TransactionInput =>
  new TransactionInput.TransactionInput({
    transactionId: TransactionHash.fromHex(ref.txHash),
    index: BigInt(ref.index),
  })

/**
 * A resolved chain row to the review IR's input.
 *
 * ⚠️ No decode step and no failure path: the address arrives decoded, where the wallet-shaped
 * port handed back a bech32 string that had to be pushed through the codec again — inside a
 * try/catch, for an address the provider had just parsed.
 */
const resolvedInputOf = (utxo: EvolutionUTxO.UTxO): ResolvedInput => ({
  txHashHex: TransactionHash.toHex(utxo.transactionId),
  index: Number(utxo.index),
  addressHex: EvolutionAddress.toHex(utxo.address),
  addressBech32: EvolutionAddress.toBech32(utxo.address),
  coin: utxo.assets.lovelace,
  tokens: [...(utxo.assets.multiAsset?.map.entries() ?? [])].flatMap(([policy, names]) =>
    [...names.entries()].map(([name, amount]) => ({
      policyIdHex: Bytes.toHex(policy.hash),
      assetNameHex: Bytes.toHex(name.bytes),
      amount,
    })),
  ),
})

/** `txHash#index`, lowercased — the identity of an outpoint on both sides of the merge. */
const refId = (txHash: string, index: number): string => `${txHash.toLowerCase()}#${index}`

export type Outpoint = {readonly txHash: TxHashHex; readonly index: number}

/**
 * The body's inputs that `known` does not already account for.
 *
 * Pure and separately testable, because the two ways to get this wrong are both silent:
 * asking the indexer for coins we already hold (a wasted call on every review), and
 * comparing hex case-sensitively (every input looks foreign, so every input gets fetched).
 */
export const missingOutpointsOf = (
  bodyInputs: readonly Outpoint[],
  known: readonly ResolvedInput[],
): readonly Outpoint[] => {
  const have = new Set(known.map((input) => refId(input.txHashHex, input.index)))
  const missing: Outpoint[] = []
  const seen = new Set<string>()
  for (const input of bodyInputs) {
    const id = refId(input.txHash, input.index)
    if (have.has(id) || seen.has(id)) continue
    seen.add(id)
    missing.push(input)
  }
  return missing
}

/**
 * How many of a body's inputs the chain says are already spent.
 *
 * A gathering transaction is a claim on coins that nobody has locked. Between building it
 * and collecting the last signature, any party can spend their own input somewhere else —
 * and then no set of signatures can make this transaction submittable. It is not a failure
 * to report at submit: the co-signer is being asked to approve something that cannot happen.
 *
 * `spent` is optional on a resolved row and **`undefined` means unknown, not unspent** — the
 * provider's own note. Only an explicit `true` counts, so a backend that does not answer leaves
 * the transaction alone rather than declaring it dead.
 *
 * ⚠️ **`resolveOutRefs`, not `getUtxosByOutRef`.** The latter answers "what can I spend": it
 * filters a consumed output away and carries no flag, so this count over it is always zero.
 * A backend without the member answers 0 for "unknown", which is the state before this existed.
 *
 * Never fails: an unreachable indexer means "we do not know".
 */
export const spentInputCountOf = (rail: CardanoRail, bodyHex: string): Effect.Effect<number, never, Decode> =>
  Effect.gen(function* () {
    const resolve = rail.chain.resolveOutRefs
    if (resolve === undefined) {
      logger.debug('This backend cannot resolve a spent outpoint; input liveness is unknown', {
        origin: 'cosign/foreign-inputs',
      })
      return 0
    }
    const inputs = yield* Inspect.txBody(bodyHex).pipe(
      Effect.map(({body}) => (body.inputs ?? []).map((i) => ({txHash: TxHashHex(i.txHashHex), index: i.index}))),
      Effect.orElseSucceed(() => [] as readonly Outpoint[]),
    )
    if (inputs.length === 0) return 0
    const resolved = yield* resolve(inputs.map(inputOf)).pipe(Effect.orElseSucceed(() => []))
    return resolved.filter((row) => row.spent === true).length
  })

/**
 * Merge chain-resolved inputs behind the wallet's own.
 *
 * Own-first is the trust order and the information order at once: a duplicate can only mean
 * the indexer answered for a coin we already hold, and our own entry is the better one.
 */
export const mergeResolvedInputs = (
  own: readonly ResolvedInput[],
  fetched: readonly ResolvedInput[],
): readonly ResolvedInput[] => {
  const have = new Set(own.map((input) => refId(input.txHashHex, input.index)))
  return [...own, ...fetched.filter((input) => !have.has(refId(input.txHashHex, input.index)))]
}

/**
 * Every input of `bodyHex`, resolved: this wallet's from `own`, the rest from the chain.
 *
 * Never fails. A review that cannot reach the indexer is the review we already had — inputs
 * unresolved and the warning that says amounts may be incomplete — and losing the amounts
 * entirely because one lookup timed out would be worse than the state this exists to fix.
 */
export const resolveInputsWithChain = (
  rail: CardanoRail,
  bodyHex: string,
  own: readonly ResolvedInput[],
): Effect.Effect<readonly ResolvedInput[], never, Decode> =>
  Effect.gen(function* () {
    const inputs = yield* Inspect.txBody(bodyHex).pipe(
      Effect.map(({body}) => (body.inputs ?? []).map((i) => ({txHash: TxHashHex(i.txHashHex), index: i.index}))),
      Effect.orElseSucceed(() => [] as readonly Outpoint[]),
    )
    const missing = missingOutpointsOf(inputs, own)
    if (missing.length === 0) return own

    // ⚠️ `resolveOutRefs` so a SPENT input still resolves. `getUtxosByOutRef` drops it, and a
    // review of a transaction whose inputs are gone would then misstate the amounts rather than
    // state them alongside the warning the unresolved set carries.
    const resolve = rail.chain.resolveOutRefs
    const refs = missing.map(inputOf)
    const resolved =
      resolve === undefined
        ? yield* rail.chain.getUtxosByOutRef(refs).pipe(Effect.orElseSucceed(() => unresolved(missing)))
        : yield* resolve(refs).pipe(
            Effect.map((rows) => rows.map((row) => row.utxo)),
            Effect.orElseSucceed(() => unresolved(missing)),
          )
    return mergeResolvedInputs(own, resolved.map(resolvedInputOf))
  })

/**
 * The empty answer, logged.
 *
 * Not silent: an unresolved input is the difference between a review that states the
 * transaction and one that misstates it, and a co-signer has no other way to tell which of the
 * two they are reading.
 */
const unresolved = (missing: readonly Outpoint[]): readonly EvolutionUTxO.UTxO[] => {
  logger.warn('co-sign review could not resolve foreign inputs', {
    origin: 'resolveInputsWithChain',
    missing: missing.length,
  })
  return []
}
