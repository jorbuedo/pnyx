/**
 * The consolidation build loop: turning the pure plan into signable transactions.
 *
 * Two protocol bounds decide the shape and neither is knowable without building,
 * so this is where the library's measuring primitives are consumed:
 * `Plan.fitBySize` settles how many inputs fit one transaction, and
 * `Plan.packAssetsByValueSize` settles how many outputs the assets need.
 *
 * Legs are **independent**, not chained. Each fold consumes its own disjoint
 * slice of the candidate set, so leg 2 is valid whether or not leg 1 lands —
 * unlike the send compose queue, where a later leg spends an earlier leg's
 * change and a failure has to cascade. That is why nothing here touches
 * `send-queue`: there is no dependency to persist.
 *
 * The inputs are pinned with `mandatoryInputs` rather than offered to coin
 * selection. Consolidation is not "cover this amount" — it is "spend exactly
 * these UTxOs" — and coin selection would drop the small ones, which are the
 * whole point.
 *
 * One invariant worth stating because it is not obvious and it is load-bearing:
 * **min-ADA is never what makes a fold of two or more UTxOs unaffordable.**
 * Merging N asset-bearing UTxOs into M ≤ N outputs shares one 160-byte overhead,
 * one address and one policy map where there were N of each, so the merged floor
 * is strictly below the sum of the floors those inputs already satisfy — and the
 * difference pays the fee. That is why there is no affordability search here.
 *
 * The invariant fails at N = 1, and that is not academic: a mainnet UTxO holding
 * 3.66 ADA and 19 tokens needs ~3.6 ADA of min-ADA for the single output it would
 * fold into, leaving nothing for the fee. Hence {@link MIN_FOLD_INPUTS}, which
 * the size fitter is told about so it never probes a prefix of one.
 *
 * @module
 */

import type {UTxO} from '@evolution-sdk/evolution'
import {Bytes, Assets as EvAssets} from '@evolution-sdk/evolution'
import {Plan} from '@evolution-sdk/plan'
import type {TxHashHex} from '@evolution-sdk/review/Brands'
import {Decode} from '@evolution-sdk/review/Decode'
import type {CborError} from '@evolution-sdk/review/Errors'
import {Tx} from '@pnyx/cardano-core'
import {resolveCardanoSigningPaths, reviewCardanoTx} from '@pnyx/tx-review'
import {utxoId} from '@pnyx/wallet'
import {Data, Effect} from 'effect'
import {minAdaForOutput} from '../../../screens/cardano/send/min-ada'
import {accountScriptContext} from '../account'
import {type BuildFailureKind, classifyBuildFailure} from '../build-failure'
import type {CardanoRail} from '../rail'
import {
  distinctSignerCount,
  ownUtxoFromValue,
  resolveOwnInputs,
  type SendReview,
  unconfirmedTxHashesOf,
} from '../send-flow'
import type {SendQueueRequest} from '../send-queue/model'
import {fetchStakeAccountState, rewardAddress} from '../staking/staking-flow'
import {
  type ExclusionReason,
  orderAssetsForPacking,
  reducesUtxoCount,
  selectConsolidationCandidates,
  totalAssets,
  totalLovelace,
} from './plan'
import type {WalletOptimization} from './policy'

/** Protocol params as the rail's provider reports them. */
type Params = Plan.ProtocolParams

export class ConsolidationError extends Data.TaggedError('ConsolidationError')<{
  readonly reason: string
  readonly kind: BuildFailureKind | 'empty-wallet' | 'nothing-to-do'
}> {}

/**
 * How many transactions one consolidation may produce. Not a protocol limit — a
 * consent limit, the same reasoning as the send queue's: every leg is reviewed
 * in one ceremony, and a ceremony nobody reads is not consent.
 */
export const MAX_CONSOLIDATION_LEGS = 5

/**
 * The smallest fold worth building. One input in, one output out reduces nothing
 * — see {@link reducesUtxoCount} — and asking the size fitter to probe it raises
 * a spurious insufficient-funds failure for a leg no caller wanted.
 */
export const MIN_FOLD_INPUTS = 2

export type ConsolidationLeg = {
  /** Same shape the send flow produces, so the review ceremony is unchanged. */
  readonly review: SendReview
  readonly inputCount: number
  /** Explicit asset outputs plus change — what the wallet is left holding. */
  readonly outputCount: number
  readonly fee: bigint
  readonly size: number
}

/** Why the fold loop stopped — the difference between "done" and "did what it could". */
export type ConsolidationStop =
  /** Nothing left worth folding. */
  | 'complete'
  /** {@link MAX_CONSOLIDATION_LEGS} reached with candidates still unfolded. */
  | 'leg-cap'
  /** The next fold would have produced as many outputs as it consumed. */
  | 'no-reduction'

export type ConsolidationOutcome = {
  readonly legs: readonly ConsolidationLeg[]
  /** Held back by policy, with the reason. Never silently dropped. */
  readonly excluded: readonly {readonly utxo: UTxO.UTxO; readonly reason: ExclusionReason}[]
  /**
   * Candidates no leg could take — the leg cap was reached, or what was left
   * would not have reduced the set. Distinct from `excluded`: these were not
   * refused by policy, there was simply no room. Read with {@link stop}.
   */
  readonly remaining: readonly UTxO.UTxO[]
  readonly stop: ConsolidationStop
  readonly utxosBefore: number
  readonly utxosAfter: number
  readonly totalFee: bigint
  /** Rewards folded in, when `autoWithdrawRewards` found any. */
  readonly withdrawnRewards: bigint
}

type Withdrawal = {readonly rewardAcctHex: string; readonly amount: bigint}

/**
 * How many distinct vkey witnesses this leg needs — the payment witnesses its
 * inputs demand, plus the stake key when rewards are withdrawn in the same
 * transaction.
 *
 * Exact up front, unlike the send side's fixed point, because a fold's inputs are
 * pinned rather than coin-selected.
 */
export const consolidationSignerCount = (inputs: readonly UTxO.UTxO[], withWithdrawal: boolean): number =>
  distinctSignerCount(inputs) + (withWithdrawal ? 1 : 0)

/**
 * Whether the wallet holds a key that can witness spending this UTxO.
 *
 * Not a hypothetical guard. A watch-only wallet reads its UTxOs account-level,
 * keyed on the stake credential — so whatever a *script* holds under that same
 * stake credential (a DEX order, an escrow) comes back in the very same list.
 * The mainnet test wallet has two. Folding one produces a transaction no key can
 * sign, and `resolveCardanoSigningPaths` deliberately skips script credentials,
 * so nothing downstream would have objected.
 *
 * `paymentKeyHashes` is the authority because it is built from *our own*
 * derivation, with script credentials already rejected — a foreign address that
 * reuses our public stake key never enters it.
 */
export const isSpendableByWallet = (rail: CardanoRail, utxo: UTxO.UTxO): boolean => {
  // ⚠️ Straight off the typed address. This used to render the UTxO's address to bech32, parse
  // that back to hex and inspect the hex — three conversions to reach a credential the `UTxO`
  // already carries. The parse is also why this needed a try/catch: an address that came off a
  // typed `UTxO` cannot fail to read, so there is no longer a failure to swallow or to log.
  const credential = utxo.address.paymentCredential
  if (credential._tag !== 'KeyHash') return false
  return rail.account.walletContext.paymentKeyHashes.has(Bytes.toHex(credential.hash))
}

/**
 * An own-address output carrying one packed asset group at exactly its min-ADA.
 * Anything above the floor would be ADA locked away from the next send for no
 * reason.
 */
const assetGroupOutput = (
  rail: CardanoRail,
  coinsPerUtxoByte: bigint,
  group: readonly Plan.AssetAmount[],
): Plan.PlanOutput => {
  const amounts = new Map(group.map((a) => [a.assetId, a.amount] as const))
  const floor = minAdaForOutput(coinsPerUtxoByte, rail.account.addressHex, amounts)
  if (floor === null) throw new Error('cannot size a consolidation output for the packed assets')
  return {
    addressHex: rail.account.addressHex,
    assets: EvAssets.fromRecord({
      lovelace: floor,
      ...Object.fromEntries(group.map((a) => [a.assetId, a.amount] as const)),
    }),
  }
}

/**
 * The explicit outputs a fold of `inputs` needs, beyond the change output the
 * balancer already emits.
 *
 * The first packed group rides in change — it costs nothing extra, since change
 * exists regardless — so only the groups after it need an output of their own.
 * Packing measures against the leg's *whole* lovelace rather than a nominal
 * min-ADA, because change carries all of it and a wider coin integer makes the
 * serialized value a byte or two larger; measuring against the larger figure
 * keeps the estimate on the safe side of a bound the builder then enforces.
 */
export const consolidationAssetOutputs = (
  rail: CardanoRail,
  params: Params,
  inputs: readonly UTxO.UTxO[],
  policy: WalletOptimization,
): readonly Plan.PlanOutput[] => {
  const maxValueSize = params.maxValueSize
  if (maxValueSize === undefined) return []
  const assets = orderAssetsForPacking(totalAssets(inputs), policy)
  if (assets.length === 0) return []
  const {groups} = Plan.packAssetsByValueSize(assets, maxValueSize, totalLovelace(inputs))
  return groups.slice(1).map((group) => assetGroupOutput(rail, params.coinsPerUtxoByte, group))
}

/** The claimable-rewards withdrawal, or `null` when there is nothing to fold in. */
const rewardWithdrawal = (rail: CardanoRail): Effect.Effect<Withdrawal | null> =>
  fetchStakeAccountState(rail).pipe(
    Effect.map((state) =>
      // No stake credential means no reward account to withdraw from.
      state.rewardsAvailable > 0n && rewardAddress(rail) !== null
        ? {rewardAcctHex: (rewardAddress(rail) as {hex: string}).hex, amount: state.rewardsAvailable}
        : null,
    ),
    // A provider without account indexing is not a reason to refuse to
    // consolidate — it only means rewards cannot be folded in.
    Effect.orElseSucceed(() => null),
  )

/**
 * Fold the largest prefix of `candidates` that fits one transaction.
 *
 * `fitBySize` is called with the real plan, so the build it returns is the one
 * that gets signed — no separate confirmation pass that could land a byte off.
 */
const buildLeg = (
  rail: CardanoRail,
  groupId: string,
  params: Params,
  candidates: readonly UTxO.UTxO[],
  policy: WalletOptimization,
  withdrawal: Withdrawal | null,
): Effect.Effect<ConsolidationLeg, ConsolidationError | CborError> =>
  Effect.gen(function* () {
    const planInputs = candidates.map((utxo) => ({
      txHash: utxoId(utxo).split(':')[0] as TxHashHex,
      index: Number(utxo.index),
      assets: utxo.assets,
    }))

    const planFor = (take: number): Plan.UnsignedCardanoPlan => {
      const inputs = candidates.slice(0, take)
      return {
        // Nothing selectable: a consolidation spends exactly what it was given.
        inputs: [],
        mandatoryInputs: planInputs.slice(0, take),
        outputs: consolidationAssetOutputs(rail, params, inputs, policy),
        changeAddressHex: rail.account.addressHex,
        params,
        ...(withdrawal !== null ? {withdrawals: [withdrawal]} : {}),
        signerCount: consolidationSignerCount(inputs, withdrawal !== null),
      }
    }

    // `minTake` of 2, not 1: a one-input fold is not a fold, and a lone
    // asset-bearing UTxO cannot pay a fee on top of the min-ADA its own assets
    // already demand — measured on mainnet, where a 3.66 ADA / 19-token UTxO
    // needs ~3.6 ADA of min-ADA and the probe at 1 failed the whole plan.
    const fit = yield* Effect.try({
      try: () => Plan.fitBySize(planFor, candidates.length, undefined, MIN_FOLD_INPUTS),
      catch: (e) => new ConsolidationError(classifyBuildFailure(e)),
    })
    const built = fit.built
    const taken = candidates.slice(0, fit.taken)

    // No change output means the fold went entirely to the fee — there is no
    // consolidated UTxO at the end of it, which is the opposite of the point.
    if (built.changeOutputs.length === 0) {
      return yield* Effect.fail(
        new ConsolidationError({
          reason: 'the fold emitted no output; its whole value would go to fee',
          kind: 'build-failed',
        }),
      )
    }

    const consumedUtxoIds = taken.map(utxoId)
    const unconfirmed = yield* unconfirmedTxHashesOf(rail)
    const resolvedInputs = resolveOwnInputs(taken, unconfirmed)

    const reviewed = yield* reviewCardanoTx(
      built.bodyHex,
      rail.account.walletContext,
      resolvedInputs,
      params,
      undefined,
      built.feeBreakdown,
    ).pipe(
      Effect.mapError((e) => new ConsolidationError({reason: e.message, kind: 'build-failed'})),
      Effect.provideService(Decode, rail.decode),
    )

    const txHash = Tx.bodyHash(built.bodyHex)
    // Every output is ours, so all of them stay spendable: the packed asset
    // groups as much as the change. Listing only change would hide those assets
    // from the balance until the transaction confirmed.
    const assetOutputs = consolidationAssetOutputs(rail, params, taken, policy)
    const produced = yield* Effect.forEach(
      [...assetOutputs.map((o, index) => ({assets: o.assets, txHash, index})), ...built.changeOutputs],
      (out) => Effect.succeed(ownUtxoFromValue(rail, out.assets, out)),
    )

    const signing = yield* resolveCardanoSigningPaths(
      built.bodyHex,
      rail.account.keyRegistry,
      resolvedInputs,
      accountScriptContext(rail.account),
    ).pipe(
      Effect.mapError((e) => new ConsolidationError({reason: `signing paths: ${e.message}`, kind: 'build-failed'})),
      Effect.provideService(Decode, rail.decode),
    )

    const request: SendQueueRequest = {
      groupId,
      payload: {
        _tag: 'CardanoTx',
        bodyHex: built.bodyHex,
        networkId: rail.config.networkId,
        protocolMagic: rail.config.protocolMagic,
        precomputedSigningPaths: signing.signingPaths,
        precomputedRequiredKeyHashes: signing.requiredKeyHashes,
      },
    }

    const review: SendReview = {
      reviewed,
      bodyHex: built.bodyHex,
      request,
      tracked: {consumedUtxoIds, change: produced},
      txHash,
      changePlan: {changeOutputs: built.changeOutputs},
    }
    return {
      review,
      inputCount: fit.taken,
      outputCount: produced.length,
      fee: built.fee,
      size: built.size,
    }
  })

/** The part of a leg the fold loop reasons about; the rest is the caller's. */
type LegShape = {readonly inputCount: number; readonly outputCount: number}

/**
 * Walk the candidate list, folding one leg at a time until nothing useful is
 * left. Independent of the rail so the sequencing rules are testable on their
 * own — how many legs, which slice each gets, and when to stop.
 *
 * `buildOne` receives what is still unfolded plus whether this is the first leg,
 * because a reward withdrawal can only happen once and belongs to leg one.
 *
 * Stops — rather than shrinking the slice and retrying — as soon as a leg would
 * not reduce the set. Later candidates only make a leg bigger, so a fold that
 * cannot pay for itself here cannot pay for itself further down the list either.
 */
export const foldConsolidationLegs = <L extends LegShape, E>(
  candidates: readonly UTxO.UTxO[],
  maxLegs: number,
  buildOne: (remaining: readonly UTxO.UTxO[], isFirst: boolean) => Effect.Effect<L, E>,
): Effect.Effect<
  {readonly legs: readonly L[]; readonly remaining: readonly UTxO.UTxO[]; readonly stop: ConsolidationStop},
  E
> =>
  Effect.gen(function* () {
    const legs: L[] = []
    let remaining = candidates
    // One UTxO left is not a fold, so two is the floor for another leg.
    while (remaining.length >= MIN_FOLD_INPUTS) {
      if (legs.length >= maxLegs) return {legs, remaining, stop: 'leg-cap' as const}
      const leg = yield* buildOne(remaining, legs.length === 0)
      // A fold producing as many outputs as it consumed shrinks nothing. Real
      // outcome for assets spread across enough policies that every output fills
      // up — and it must not be charged a fee.
      if (!reducesUtxoCount(leg.inputCount, leg.outputCount)) {
        return {legs, remaining, stop: 'no-reduction' as const}
      }
      legs.push(leg)
      remaining = remaining.slice(leg.inputCount)
    }
    return {legs, remaining, stop: 'complete' as const}
  })

/**
 * Plan and build a consolidation for the wallet's current UTxO set.
 *
 * Fails rather than producing a token gesture: a fold that would not reduce the
 * UTxO count is `nothing-to-do`, not an empty success, because charging a fee to
 * change nothing is worse than declining. What it *does* do is report every
 * partial outcome — UTxOs held back by policy, and candidates left over because
 * the leg cap was reached — so the caller can say so instead of implying the
 * wallet was fully consolidated.
 */
export const buildConsolidation = (
  rail: CardanoRail,
  groupId: string,
  policy: WalletOptimization,
): Effect.Effect<ConsolidationOutcome, ConsolidationError | CborError> =>
  Effect.gen(function* () {
    const spendable = yield* rail.spendableUtxos
    if (spendable.length === 0) {
      return yield* Effect.fail(new ConsolidationError({reason: 'no spendable UTxOs', kind: 'empty-wallet'}))
    }
    const params = yield* rail.protocolParams.pipe(
      Effect.mapError((e) => new ConsolidationError({reason: e.message, kind: 'build-failed'})),
    )

    const witnessable = spendable.filter((utxo) => isSpendableByWallet(rail, utxo))
    const unwitnessable = spendable
      .filter((utxo) => !isSpendableByWallet(rail, utxo))
      .map((utxo) => ({utxo, reason: 'not-spendable' as const}))

    const {candidates, excluded: byPolicy} = selectConsolidationCandidates(witnessable, policy)
    const excluded = [...unwitnessable, ...byPolicy]
    if (candidates.length < MIN_FOLD_INPUTS) {
      return yield* Effect.fail(new ConsolidationError({reason: 'fewer than two UTxOs to fold', kind: 'nothing-to-do'}))
    }

    const withdrawal = policy.autoWithdrawRewards ? yield* rewardWithdrawal(rail) : null

    const {legs, remaining, stop} = yield* foldConsolidationLegs(candidates, MAX_CONSOLIDATION_LEGS, (rest, isFirst) =>
      buildLeg(rail, groupId, params, rest, policy, isFirst ? withdrawal : null),
    )

    if (legs.length === 0) {
      return yield* Effect.fail(
        new ConsolidationError({reason: 'folding these UTxOs would not reduce the set', kind: 'nothing-to-do'}),
      )
    }

    const consumed = legs.reduce((n, l) => n + l.inputCount, 0)
    const produced = legs.reduce((n, l) => n + l.outputCount, 0)
    return {
      legs,
      excluded,
      remaining,
      stop,
      utxosBefore: spendable.length,
      utxosAfter: spendable.length - consumed + produced,
      totalFee: legs.reduce((sum, l) => sum + l.fee, 0n),
      withdrawnRewards: withdrawal === null ? 0n : withdrawal.amount,
    } satisfies ConsolidationOutcome
  })
