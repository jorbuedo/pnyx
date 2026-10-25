/**
 * Cardano transactions built for an agent: intent in, unsigned transaction out.
 *
 * ⚠️ **This is the family CIP-30 leaves out.** A connector hands out UTxOs and takes a finished body; it
 * never builds. A dApp brings its own builder, so an agent needs one too — and exposing *ours* is the
 * safer of the two options rather than an expansion (`docs/MCP_DEV_TOOL_SPEC.md` §3.2). It adds no
 * authority: nothing here signs and nothing here submits, coin selection and fees stay the planner's,
 * and what comes out still reaches the person on the one review screen.
 *
 * **It reuses the send flow rather than forking it.** `buildEnhancedSendReview` is the same builder the
 * send screen drives, so a transfer built for an agent gets the same coin selection, the same
 * witness-count fixed point, the same review IR — including the real `feeBreakdown`, where a body handed
 * to us as bytes reviews against a flat cap.
 *
 * @module
 */

import type {UTxO} from '@evolution-sdk/evolution'
import * as Cbor from '@evolution-sdk/evolution/CBORBuilder'
import {AddressHex, KeyHashHex} from '@evolution-sdk/review/Brands'
import type {CborError} from '@evolution-sdk/review/Errors'
import {Scripts, Tx} from '@pnyx/cardano-core'
import type {CoreError} from '@pnyx/cardano-core/Op'
import type {SigningRequest} from '@pnyx/signing-service'
import type {ReviewedTransaction} from '@pnyx/tx-review'
import {Effect} from 'effect'
import {minAdaForOutput} from '../../screens/cardano/send/min-ada'
import type {ResolvedTarget} from '../../screens/cardano/send/state'
import type {CardanoRail} from './rail'
import {buildEnhancedSendReview, SendBuildError, type SendReview} from './send-flow'
import {MAX_QUEUED_LEGS, type SendQueueLeg} from './send-queue/model'
import {isChainable, legFromSendReview, queueOverlayEntries} from './send-queue/overlay'
import type {SignerKind} from './signer-kind'
import {buildDelegationReview, fetchStakeAccountState, type StakeBuildError} from './staking/staking-flow'
import type {DelegationSelection} from './staking/state'

/**
 * What every builder here produces, whoever built it.
 *
 * ⚠️ **The common shape of a `SendReview` and a `StakeReview`, not one of them.** A transfer, a mint and
 * a delegation come out of three different flows with three different result types, and the review
 * ceremony wants the same four fields from each — so the agent surface names those four rather than
 * picking a favourite and converting the others into it.
 */
export type AgentBuild = {
  readonly reviewed: ReviewedTransaction
  readonly bodyHex: string
  readonly request: SigningRequest
  /** Pending-tx overlay to register once it is broadcast, so the next build sees this one's change. */
  readonly tracked: {readonly consumedUtxoIds: readonly string[]; readonly change: readonly UTxO.UTxO[]}
  /** Fixed once the body is built; signing only adds a witness set. */
  readonly txHash: string
  /**
   * The whole transaction, unsigned — body, an empty witness set, and any auxiliary data.
   *
   * ⚠️ **Assembled, not the bare body.** `signTx` takes a *transaction*, and the aux data has to travel
   * with it: the body commits to an aux-data hash, so a memo left behind would make the transaction
   * malformed at exactly the point nobody is looking any more.
   */
  readonly unsignedTxHex: string
}

/**
 * One flow's result, as the agent surface holds it.
 *
 * Exported because a consolidation arrives as a *list* of these from a planner that has already built
 * them — it is the seam between "some flow produced a review" and "the agent surface can carry it".
 */
export const agentBuildFrom = (review: {
  readonly reviewed: ReviewedTransaction
  readonly bodyHex: string
  readonly request: SigningRequest
  readonly tracked: AgentBuild['tracked']
}): Effect.Effect<AgentBuild, CoreError> =>
  Effect.map(unsignedTxHexOf(review.bodyHex, review.request), (unsignedTxHex) => ({
    ...review,
    txHash: Tx.bodyHash(review.bodyHex),
    unsignedTxHex,
  }))

/** Wrap a built body into the unsigned transaction a CIP-30 `signTx` expects. */
export const unsignedTxHexOf = (bodyHex: string, request: SigningRequest): Effect.Effect<string, CoreError> => {
  const payload = request.payload
  if (payload._tag !== 'CardanoTx') return Effect.succeed('')
  return Tx.assemble(bodyHex, [], {
    ...(payload.nativeScripts !== undefined ? {nativeScripts: payload.nativeScripts} : {}),
    ...(payload.witnessExtra !== undefined ? {witnessExtra: payload.witnessExtra} : {}),
    ...(payload.auxHex !== undefined ? {auxHex: payload.auxHex} : {}),
  })
}

/**
 * Raise this output to its min-ADA floor, leaving anything already above it alone.
 *
 * ⚠️ **The planner does not do this for explicit outputs.** It raises only *change* to the floor
 * and passes everything else through verbatim — so an asset-bearing output left at zero builds,
 * proves and is then refused by the ledger as `OutputTooSmallUTxO`. Nothing host-side shows that;
 * the first evidence is a rejected submission.
 *
 * ⚠️ **Throws when the floor cannot be measured**, which is what the codec call it replaced did.
 * `minAdaForOutput` answers `null` for "unknown", and passing an unraised output through on that
 * basis is exactly the rejected submission above — silently this time.
 */
export const withMinAda = (coinsPerUtxoByte: bigint, target: ResolvedTarget): ResolvedTarget => {
  const floor = minAdaForOutput(coinsPerUtxoByte, AddressHex(target.addressHex), target.amounts, {
    ...(target.datumHex !== undefined ? {datumHex: target.datumHex} : {}),
    ...(target.scriptRefHex !== undefined ? {scriptRefHex: target.scriptRefHex} : {}),
  })
  if (floor === null) {
    throw new Error(`min-ADA could not be measured for the output at ${target.addressHex.slice(0, 16)}…`)
  }
  const coin = target.amounts.get('') ?? 0n
  if (coin >= floor) return target
  return {...target, amounts: new Map([...target.amounts, ['', floor]])}
}

export type TransferIntent = {
  readonly targets: readonly ResolvedTarget[]
  readonly memo?: string
}

/** Build one transfer — N recipients, multi-asset each, an optional CIP-20 memo. */
export const buildAgentTransfer = (
  rail: CardanoRail,
  groupId: string,
  intent: TransferIntent,
): Effect.Effect<AgentBuild, SendBuildError | CborError | CoreError> =>
  Effect.gen(function* () {
    return yield* agentBuildFrom(yield* buildEnhancedSendReview(rail, groupId, intent))
  })

/**
 * How many of these recipients fit in one transaction — for the sentence an agent is told when they do
 * not all fit.
 *
 * ⚠️ **A binary search, not the send screen's walk down from the full set.** That walk is bounded by
 * `MAX_TARGETS`, five; an airdrop is hundreds, and rebuilding once per dropped recipient would take
 * hundreds of builds. This is a handful.
 *
 * Returns 0 when even one recipient will not build — which is a different problem (not enough ADA, a
 * wallet needing consolidation) and must not be reported as "your list is too long".
 */
export const largestFittingTargetCount = (
  rail: CardanoRail,
  groupId: string,
  intent: TransferIntent,
): Effect.Effect<number, never> =>
  Effect.gen(function* () {
    const builds = (take: number) =>
      Effect.map(
        Effect.either(buildEnhancedSendReview(rail, groupId, {...intent, targets: intent.targets.slice(0, take)})),
        (e) => e._tag === 'Right',
      )
    const total = intent.targets.length
    if (total === 0) return 0
    // ⚠️ The whole set first, and not as an optimisation: the search below needs a count that is *known*
    // not to build as its upper bound, and `total` is only known to fail once it has been tried.
    if (yield* builds(total)) return total
    let low = 0
    let high = total
    // Invariant: `low` builds or is zero, `high` does not. Narrow until they are adjacent.
    while (high - low > 1) {
      const mid = Math.floor((low + high) / 2)
      if (yield* builds(mid)) low = mid
      else high = mid
    }
    return low
  })

/**
 * A mint-and-distribute: one policy, one asset, any number of recipients, in one transaction.
 *
 * ⚠️ **The policy is this wallet's own payment key**, so the wallet that mints is the wallet that can
 * mint again — unless `lockAfterSlot` is given, which is what makes a supply provably final. That
 * choice belongs to the caller and has no safe default: an unlockable policy is right for a currency
 * and wrong for an NFT, and guessing either way would be a claim about the token nobody made.
 */
export type MintIntent = {
  /** The asset name as bytes, hex. Up to 32 bytes; empty is legal and means a nameless asset. */
  readonly assetNameHex: string
  /** Total minted. What the recipients do not take comes back to this wallet as change. */
  readonly quantity: bigint
  readonly recipients: readonly {readonly addressHex: string; readonly quantity: bigint}[]
  /**
   * Slot after which this policy can never mint again.
   *
   * Bounds the transaction's own validity too, because a `invalid_hereafter` script is only satisfied
   * by a transaction that cannot outlive it.
   */
  readonly lockAfterSlot?: number
  /** CIP-25 (label 721) metadata for this asset, already encoded as auxiliary data. */
  readonly auxiliaryDataHex?: string
}

/** What a mint produced, beside the build: the caller needs the policy to say what was minted. */
export type AgentMint = AgentBuild & {
  readonly policyId: string
  readonly assetId: string
}

/**
 * The native script authorising this wallet to mint, and its policy id.
 *
 * `all [pubkey, invalid_hereafter]` when a lock slot is given — the CIP-25 convention for a supply that
 * can be proven final — and a bare `pubkey` otherwise.
 */
export const mintingPolicyFor = (
  rail: CardanoRail,
  lockAfterSlot?: number,
): Effect.Effect<{readonly scriptHex: string; readonly policyId: string}, CoreError> =>
  Effect.gen(function* () {
    const pubkey = yield* Scripts.pubkey(KeyHashHex(rail.account.paymentKeyHashHex))
    const scriptHex =
      lockAfterSlot === undefined
        ? pubkey
        : yield* Scripts.all([pubkey, yield* Scripts.invalidHereafter(BigInt(lockAfterSlot))])
    return {scriptHex, policyId: yield* Scripts.scriptHash(scriptHex)}
  })

export const buildAgentMint = (
  rail: CardanoRail,
  groupId: string,
  intent: MintIntent,
): Effect.Effect<AgentMint, SendBuildError | CborError | CoreError> =>
  Effect.gen(function* () {
    const policy = yield* mintingPolicyFor(rail, intent.lockAfterSlot)
    const assetId = `${policy.policyId}.${intent.assetNameHex}`
    const {coinsPerUtxoByte} = yield* rail.protocolParams.pipe(
      Effect.mapError((e) => new SendBuildError({reason: e.message, kind: 'build-failed'})),
    )
    const targets: readonly ResolvedTarget[] = intent.recipients.map((r) =>
      // ⚠️ Raised here, not left to the planner: it floors only *change*, so a recipient's output would
      // otherwise go out below min-ADA and be refused by the ledger rather than by anything we can see.
      withMinAda(coinsPerUtxoByte, {
        addressHex: AddressHex(r.addressHex),
        amounts: new Map([
          ['', 0n],
          [assetId, r.quantity],
        ]),
      }),
    )
    const review = yield* buildEnhancedSendReview(rail, groupId, {
      targets,
      mint: [{assetId, amount: intent.quantity, policyScriptHex: policy.scriptHex}],
      ...(intent.lockAfterSlot !== undefined ? {ttl: intent.lockAfterSlot} : {}),
      ...(intent.auxiliaryDataHex !== undefined ? {auxiliaryDataHex: intent.auxiliaryDataHex} : {}),
    })
    return {...(yield* agentBuildFrom(review)), policyId: policy.policyId, assetId}
  })

/**
 * Delegate this account's stake to a pool, a DRep, or both.
 *
 * ⚠️ **One pool, not a weighted split across several.** Cardano has no weighted delegation certificate:
 * "multi-pool delegation" means splitting funds across several *stake credentials*, which is a
 * different feature with its own addresses and its own consequences for spending. A tool that accepted
 * weights would have to invent that silently, so this delegates the account it was given.
 *
 * The certificates are chosen by `decideDelegation` plus `delegationCertSteps` — registration is
 * folded in when the stake key is not yet registered, which is also when the deposit is paid, and
 * a hardware or script signer gets the atomic certificates because CIP-21 forbids the combined
 * ones on a device.
 */
export const buildAgentDelegation = (
  rail: CardanoRail,
  groupId: string,
  selection: DelegationSelection,
  /** Decides whether a combined Conway certificate may be used — see `delegation-certs.ts`. */
  signer: SignerKind | null,
): Effect.Effect<AgentBuild, StakeBuildError | CborError | CoreError> =>
  Effect.gen(function* () {
    const state = yield* fetchStakeAccountState(rail)
    return yield* agentBuildFrom(yield* buildDelegationReview(rail, groupId, state, selection, signer))
  })

/** The script languages a reference script may hold, and the tag each takes in `script = [tag, bytes]`. */
export const SCRIPT_VERSION_TAG = {native: 0n, plutusV1: 1n, plutusV2: 2n, plutusV3: 3n} as const

export type ScriptVersion = keyof typeof SCRIPT_VERSION_TAG

/**
 * A `script_ref` payload: the Conway `script` sum, CBOR `[tag, bytes]`.
 *
 * ⚠️ **The caller supplies the compiled script alone**, because that is what a compiler emits and what
 * every deployment guide calls "the script". The tag that says which language it is belongs to the
 * *ledger's* encoding, not to the artifact — asking an agent to hand-assemble it would be asking it to
 * guess at a CBOR shape nothing it has ever seen contains.
 */
export const scriptRefHexFor = (version: ScriptVersion, scriptHex: string): string => {
  const bytes = Uint8Array.from(scriptHex.match(/../g) ?? [], (b) => Number.parseInt(b, 16))
  const encoded = Cbor.Serializer.newVec()
    .writeArray(Cbor.len(2))
    .writeUnsignedInteger(SCRIPT_VERSION_TAG[version])
    .writeBytes(bytes)
    .finalize() as Uint8Array
  return [...encoded].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export type DeployIntent = {
  readonly version: ScriptVersion
  /** The compiled script, hex — a Plutus script's own CBOR, or a native script's. */
  readonly scriptHex: string
  /** Where the reference UTxO sits. Defaults to this wallet, which is what keeps it spendable back. */
  readonly addressHex: string
  readonly datumHex?: string
  /** Lovelace to lock. Absent means exactly the floor, which for a script is most of the cost. */
  readonly lovelace?: bigint
}

export type AgentDeploy = AgentBuild & {
  readonly scriptRefHex: string
  /** What the reference UTxO holds, which is locked for as long as it is left there. */
  readonly lockedLovelace: bigint
}

/**
 * Publish a script as a reference input, so later transactions can point at it instead of carrying it.
 *
 * ⚠️ **The ADA is locked, not spent**, and the difference matters to whoever approves it: the output
 * belongs to this wallet and can be spent back, which destroys the reference. Anything already
 * pointing at it breaks at that moment.
 */
export const buildAgentDeploy = (
  rail: CardanoRail,
  groupId: string,
  intent: DeployIntent,
): Effect.Effect<AgentDeploy, SendBuildError | CborError | CoreError> =>
  Effect.gen(function* () {
    const {coinsPerUtxoByte} = yield* rail.protocolParams.pipe(
      Effect.mapError((e) => new SendBuildError({reason: e.message, kind: 'build-failed'})),
    )
    const scriptRefHex = scriptRefHexFor(intent.version, intent.scriptHex)
    const target: ResolvedTarget = {
      addressHex: AddressHex(intent.addressHex),
      amounts: new Map([['', intent.lovelace ?? 0n]]),
      scriptRefHex,
      ...(intent.datumHex !== undefined ? {datumHex: intent.datumHex} : {}),
    }
    const floored = withMinAda(coinsPerUtxoByte, target)
    const review = yield* buildEnhancedSendReview(rail, groupId, {targets: [floored]})
    return {
      ...(yield* agentBuildFrom(review)),
      scriptRefHex,
      lockedLovelace: floored.amounts.get('') ?? 0n,
    }
  })

/**
 * A transfer that does not fit one transaction, split into a **chain** of them.
 *
 * ⚠️ **The legs are not independent, and that is the whole point.** Leg two spends leg one's *change*,
 * so it cannot even be built until leg one exists — which is why "call again with the rest" is not an
 * answer an agent can act on: the wallet has no coins left to build the second call from until the
 * first has confirmed on chain. `composeOver` is the send funnel's own solution to exactly this, and
 * every leg is reviewed together in one ceremony.
 *
 * ⚠️ **Bounded by {@link MAX_QUEUED_LEGS}, which is a consent limit rather than a protocol one**: every
 * leg is approved in one sitting, and a ceremony nobody reads is not consent. Recipients that do not
 * fit inside the cap are **returned, never dropped** — a caller told nothing would read the result as
 * "all of them were paid".
 */
export type ChainedTransfer = {
  readonly builds: readonly AgentBuild[]
  /** Recipients no leg could take within the leg cap. Empty when every one of them is covered. */
  readonly unplaced: readonly ResolvedTarget[]
}

export const buildAgentTransferChain = (
  rail: CardanoRail,
  groupId: string,
  intent: TransferIntent,
): Effect.Effect<ChainedTransfer, SendBuildError | CborError | CoreError> =>
  Effect.gen(function* () {
    const builds: AgentBuild[] = []
    const legs: SendQueueLeg[] = []
    let remaining = intent.targets

    while (remaining.length > 0 && legs.length < MAX_QUEUED_LEGS) {
      const composeOver = yield* queueOverlayEntries(rail, legs)
      const rest = {...intent, targets: remaining, composeOver}
      // The whole remainder first: when it fits there is nothing to search for, which is every
      // ordinary send and the last leg of every chain.
      const whole = yield* Effect.either(buildEnhancedSendReview(rail, groupId, rest))
      const review = whole._tag === 'Right' ? whole.right : yield* longestFittingLeg(rail, groupId, rest, whole.left)
      builds.push(yield* agentBuildFrom(review))
      const taken = takenBy(review, remaining)
      legs.push(legFromSendReview(review, `agent-leg-${legs.length}`, legs.length))
      // ⚠️ A leg that placed nothing would loop for ever. It cannot happen — `longestFittingLeg` fails
      // rather than returning an empty build — but the guard is cheaper than trusting that.
      if (taken === 0) break
      remaining = remaining.slice(taken)
      // A leg with no change cannot be chained onto, so there is nothing for a next leg to spend.
      if (!isChainable(legs[legs.length - 1] as SendQueueLeg)) break
    }
    return {builds, unplaced: remaining}
  })

/**
 * How many of `targets` this build actually paid.
 *
 * Counted from the plan's own outputs rather than assumed, because the balancer appends change and a
 * count that guessed would slice the remainder at the wrong place — paying somebody twice or nobody.
 */
const takenBy = (review: SendReview, targets: readonly ResolvedTarget[]): number =>
  Math.min(targets.length, review.reviewed.outputs.filter((o) => o.ownership.level !== 'own').length)

/**
 * The longest prefix of the remaining recipients that builds, when the whole remainder does not.
 *
 * Only a size overflow is splittable: anything else — not enough funds, bad parameters — is a real
 * failure that must not be narrowed into a smaller leg that happens to build.
 */
const longestFittingLeg = (
  rail: CardanoRail,
  groupId: string,
  params: Parameters<typeof buildEnhancedSendReview>[2],
  failure: SendBuildError | CborError,
): Effect.Effect<SendReview, SendBuildError | CborError> =>
  Effect.gen(function* () {
    const kind = '_tag' in failure && failure._tag === 'SendBuildError' ? failure.kind : undefined
    if (kind !== 'too-large' || params.targets.length <= 1) return yield* Effect.fail(failure)
    const fits = yield* largestFittingTargetCount(rail, groupId, params)
    if (fits === 0) return yield* Effect.fail(failure)
    return yield* buildEnhancedSendReview(rail, groupId, {...params, targets: params.targets.slice(0, fits)})
  })
