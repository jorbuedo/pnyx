/**
 * Send-flow orchestration: an unsigned ADA transfer built over the rail's
 * spendable UTxO view, plus the review IR and the pending-tx tracking info the
 * review screen needs after a successful broadcast.
 *
 * ADA-only for the first cut (no multi-asset send / manual coin control); the
 * plan balancer selects inputs from the spendable set. Signing + broadcast are
 * the signing service's job — this only produces what the review screen shows
 * and what `pendingTracker.register` needs.
 *
 * @module
 */

import {
  Assets as EvAssets,
  Address as EvolutionAddress,
  Value as EvValue,
  TransactionHash,
  UTxO,
} from '@evolution-sdk/evolution'
import {Plan} from '@evolution-sdk/plan'
import type {AddressHex, TxHashHex} from '@evolution-sdk/review/Brands'
import {Decode} from '@evolution-sdk/review/Decode'
import type {CborError} from '@evolution-sdk/review/Errors'
import {Meta, Tx} from '@pnyx/cardano-core'
import type {CoreError} from '@pnyx/cardano-core/Op'
import {
  type ResolvedInput,
  type ReviewedTransaction,
  resolveCardanoSigningPaths,
  reviewCardanoTx,
} from '@pnyx/tx-review'
import {type PendingTx, projectSpendable, type UtxoOverlayEntry, utxoId} from '@pnyx/wallet'
import {Data, Effect, Either, Option} from 'effect'
import {ADA_ID, type ResolvedTarget} from '../../screens/cardano/send/state'
import {accountScriptContext, authorityPlanFields} from './account'
import {type BuildFailureKind, classifyBuildFailure} from './build-failure'
import type {CardanoRail} from './rail'
import type {SendQueueRequest} from './send-queue/model'
import {utxoAddressBech32, utxoAssetMap} from './utxo-view'

/** Where a build's change output landed, as reported by the builder. */
export type ChangeOutpoint = {readonly txHash: string; readonly index: number}

/**
 * One change output a build emitted. A build reports a *list* of these: change is
 * split across several outputs when one cannot hold it, which is what keeps a
 * token-heavy wallet spendable — `maxValueSize` bounds one output's value, and
 * change carries every asset the inputs brought that the outputs did not take.
 */
export type ChangeOutput = ChangeOutpoint & {readonly assets: EvAssets.Assets}

export class SendBuildError extends Data.TaggedError('SendBuildError')<{
  readonly reason: string
  readonly kind: BuildFailureKind | 'empty-wallet'
}> {}

export type SendReview = {
  readonly reviewed: ReviewedTransaction
  readonly bodyHex: string
  readonly request: SendQueueRequest
  /** Pending-tx overlay entry to register on a successful broadcast. */
  readonly tracked: {readonly consumedUtxoIds: readonly string[]; readonly change: readonly UTxO.UTxO[]}
  /** The tx id. Fixed once the body is built — signing only adds a witness set. */
  readonly txHash: string
  /**
   * What {@link changeUtxosFromPlan} needs to rebuild the change UTxOs later, so a
   * queued leg persists scalars instead of serialized `UTxO.UTxO`s. Empty when
   * change folded into the fee — the leg is then not chainable.
   */
  readonly changePlan: {readonly changeOutputs: readonly ChangeOutput[]}
}

/**
 * `unconfirmedTxHashes` are the transactions we have submitted but not yet seen
 * confirmed. The wallet's spendable view merges their change with confirmed
 * UTxOs on purpose — that is what makes back-to-back sends possible — so this is
 * the only point where the distinction still exists, and the review cannot state
 * it unless we pass it down.
 */
export const walletUtxoToResolvedInput = (
  utxo: UTxO.UTxO,
  addressHex: string,
  unconfirmedTxHashes: ReadonlySet<string> = new Set(),
): ResolvedInput => {
  const txHashHex = utxoId(utxo).split(':')[0] as TxHashHex
  return {
    txHashHex,
    index: Number(utxo.index),
    addressHex,
    // The review shows an input's address as-is: without this the input rows read as raw
    // hex while the output rows, decoded from the body, read as bech32 — the same address
    // written two ways in one screen.
    addressBech32: utxoAddressBech32(utxo),
    coin: utxo.assets.lovelace,
    tokens: [...utxoAssetMap(utxo)].map(([assetId, amount]) => {
      const [policyIdHex = '', assetNameHex = ''] = assetId.split('.')
      return {policyIdHex, assetNameHex, amount}
    }),
    ...(unconfirmedTxHashes.has(txHashHex) ? {fromUnconfirmedTx: true} : {}),
  }
}

/** Hashes of submitted-but-unconfirmed transactions, for the marker above. */
export const unconfirmedTxHashesOf = (rail: CardanoRail): Effect.Effect<ReadonlySet<string>> =>
  Effect.map(rail.pendingTracker.pending, (pending) => new Set(pending.map((p) => p.txHash)))

/**
 * Resolve spendable UTxOs into review inputs, each attributed to the address it
 * actually sits at.
 *
 * This replaced passing `rail.account.addressHex` for *every* input. That was not
 * cosmetic: `resolveCardanoSigningPaths` derives the required payment credentials
 * from these addresses, so a multi-address wallet required — and therefore
 * resolved — only its primary key, while the signer attaches one witness per
 * resolved path. The transaction then went out missing the witnesses its other
 * inputs needed and the ledger rejected it. The review's ownership classification
 * read the same wrong address.
 *
 * ⚠️ **No longer fallible, and not because the risk was dismissed.** It used to decode each
 * input's bech32 and fail the whole resolution rather than drop one input — skipping one costs it
 * its witness, which is the silent failure that path existed to remove. A `UTxO` carries an
 * already-decoded `Address`, so there is nothing left to decode and no undecodable input to
 * refuse: `Address.toHex` reads the bytes it already holds. The guarantee moved from a runtime
 * check into the type, and `InputAddressError` went with the check.
 */
export const resolveOwnInputs = (
  utxos: readonly UTxO.UTxO[],
  unconfirmedTxHashes: ReadonlySet<string>,
): readonly ResolvedInput[] =>
  utxos.map((utxo) => walletUtxoToResolvedInput(utxo, EvolutionAddress.toHex(utxo.address), unconfirmedTxHashes))

/**
 * How many distinct vkey witnesses a transaction spending `inputs` will carry.
 *
 * The fee is sized from this, and so therefore is the size bound. Counted from
 * distinct addresses: within one account they differ only by payment credential,
 * so this never *under*-counts — and under-counting is the dangerous direction,
 * because the ledger rejects a transaction whose fee was sized for fewer
 * witnesses than it actually carries.
 */
/**
 * ⚠️ Keyed on the bech32, never on `u.address` itself. An `Address` is an object, so a `Set` of
 * them counts by IDENTITY — two UTxOs at the same address are two entries, and the count inflates.
 * It inflates rather than deflates, so a transaction still carries enough fee, but it overpays and
 * the size bound is computed for witnesses that never arrive.
 */
export const distinctSignerCount = (inputs: readonly UTxO.UTxO[]): number =>
  Math.max(1, new Set(inputs.map(utxoAddressBech32)).size)

/**
 * Spendable view for a compose session: the rail's app-wide view (confirmed +
 * submitted-but-unconfirmed) with queued-but-unsubmitted legs layered on top.
 *
 * Deliberately *not* folded into `rail.spendableUtxos` — that feeds balances
 * everywhere, and a queued leg has not been consented to, let alone sent. Only
 * the Send build sees the queue.
 */
export const composeSpendableUtxos = (
  rail: CardanoRail,
  composeOver: readonly UtxoOverlayEntry[],
): Effect.Effect<readonly UTxO.UTxO[]> => Effect.map(rail.spendableUtxos, (base) => projectSpendable(base, composeOver))

/**
 * One of the wallet's own outputs as a spendable `UTxO.UTxO`, decoded from the
 * value the build emitted rather than from the intent that asked for it.
 *
 * Change is the common case, but a consolidation also sends packed asset groups
 * back to the wallet's own address, and those outputs are just as spendable — a
 * pending overlay that listed only change would drop them from the balance until
 * the transaction confirmed.
 */
/**
 * The two sides of the SERIALIZED edge.
 *
 * ⚠️ A queued send leg is written to storage, and its change outputs are hex there because hex
 * IS the stored format — changing it is a storage migration, not a refactor. So the bag is
 * encoded on the way into the queue and decoded on the way back out, explicitly, in one place,
 * instead of the format leaking inward through every builder.
 */
export const changeValueHex = (assets: EvAssets.Assets): string =>
  EvValue.toCBORHex(
    EvAssets.hasOnlyLovelace(assets)
      ? EvValue.onlyCoin(EvAssets.lovelaceOf(assets))
      : EvValue.withAssets(EvAssets.lovelaceOf(assets), EvAssets.getMultiAsset(assets)!),
  )

/** The inverse, for a leg read back out of storage. */
export const changeAssets = (valueHex: string): EvAssets.Assets => {
  const value = EvValue.fromCBORHex(valueHex)
  const multi = Option.getOrUndefined(EvValue.getAssets(value))
  const coin = EvValue.getAda(value)
  return multi === undefined ? EvAssets.fromLovelace(coin) : EvAssets.withMultiAsset(coin, multi)
}

/**
 * A change bag as a spendable `UTxO.UTxO`.
 *
 * ⚠️ Pure, and no longer fallible. The builder used to hand back CBOR which this decoded
 * straight away — an encode and a decode that existed only because the two sides disagreed about
 * the type. The builder reports the bag now, so there is nothing to parse and no `CborError` to
 * raise.
 */
export const ownUtxoFromValue = (rail: CardanoRail, assets: EvAssets.Assets, outpoint: ChangeOutpoint): UTxO.UTxO =>
  // ⚠️ The bag goes in as-is. It used to be unpacked into a `Map<"policy.name", bigint>` and
  // repacked before the next plan build; the UTxO carries Evolution's own `Assets` now, so the
  // builder's answer reaches the next builder without a round trip.
  new UTxO.UTxO({
    transactionId: TransactionHash.fromHex(outpoint.txHash),
    index: BigInt(outpoint.index),
    address: rail.account.address,
    assets,
  })

/**
 * The change UTxOs a build emitted, as spendable `UTxO.UTxO`s.
 *
 * The list comes from the builder, which reports where each change output
 * actually landed. This used to compute the index as "the balancer appends change
 * last" — an invariant of the plan engine's balancer asserted from here and
 * enforced by nothing — and then assumed there was only ever one, which stopped
 * being true when the balancer began splitting change to stay inside
 * `maxValueSize`.
 *
 * Empty when no change was emitted (folded into the fee), which is also exactly
 * when a leg is **not chainable**: there is no output for a later leg to spend.
 */
export const changeUtxosFromPlan = (
  rail: CardanoRail,
  changeOutputs: readonly ChangeOutput[],
): Effect.Effect<readonly UTxO.UTxO[], never> =>
  Effect.succeed(changeOutputs.map((out) => ownUtxoFromValue(rail, out.assets, out)))

/**
 * Build an unsigned ADA send + its review IR. `toAddressHex` is the recipient's
 * raw address bytes (hex); `amountLovelace` the ADA amount. The returned request
 * broadcasts (not `signOnly`) — the review screen registers pending state from
 * `tracked` after a `TxSubmitted`.
 */
export const buildSendReview = (
  rail: CardanoRail,
  groupId: string,
  params: {readonly toAddressHex: AddressHex; readonly amountLovelace: bigint},
): Effect.Effect<SendReview, SendBuildError | CborError> =>
  Effect.gen(function* () {
    const spendable = yield* rail.spendableUtxos
    if (spendable.length === 0) {
      return yield* Effect.fail(new SendBuildError({reason: 'no spendable UTxOs', kind: 'empty-wallet'}))
    }
    const protocolParams = yield* rail.protocolParams.pipe(
      Effect.mapError((e) => new SendBuildError({reason: e.message, kind: 'build-failed'})),
    )

    const planInputs = spendable.map((utxo) => ({
      txHash: utxoId(utxo).split(':')[0] as TxHashHex,
      index: Number(utxo.index),
      assets: utxo.assets,
    }))
    const outputs = [{addressHex: params.toAddressHex, assets: EvAssets.fromLovelace(params.amountLovelace)}]

    const authorityFields = authorityPlanFields(rail.account.authority)
    // The synchronous builder so the thrown cause keeps its tag — the Effect
    // wrapper flattens everything into an untagged BuildError.
    const build = (signerCount: number) =>
      Effect.try({
        try: () =>
          Plan.buildUnsigned({
            inputs: planInputs,
            outputs,
            changeAddressHex: rail.account.addressHex,
            params: protocolParams,
            // Native scripts and the validity interval a script account demands.
            // Threaded from the account so a spend cannot forget them: without
            // the scripts the transaction fails phase-1, and a time-locked
            // script fails whenever it is submitted without the interval.
            ...authorityFields,
            signerCount: signerCount + authorityFields.extraSigners,
          }),
        catch: (e) => new SendBuildError(classifyBuildFailure(e)),
      })
    const selectedFrom = (b: Plan.UnsignedPlanTx): readonly UTxO.UTxO[] => {
      const ids = new Set(b.inputs.map((i) => `${i.txHash}:${i.index}`))
      return spendable.filter((u) => ids.has(utxoId(u)))
    }

    // Size the fee for the witnesses this actually needs, not for one. See
    // `buildEnhancedSendReview` for why this is a fixed point.
    let signerCount = 1
    let built = yield* build(signerCount)
    for (let round = 0; round < 4; round++) {
      const needed = distinctSignerCount(selectedFrom(built))
      if (needed <= signerCount) break
      signerCount = needed
      built = yield* build(signerCount)
    }

    const selected = selectedFrom(built)
    const consumedUtxoIds = selected.map(utxoId)
    const unconfirmed = yield* unconfirmedTxHashesOf(rail)
    const resolvedInputs = resolveOwnInputs(selected, unconfirmed)

    const reviewed = yield* reviewCardanoTx(
      built.bodyHex,
      rail.account.walletContext,
      resolvedInputs,
      protocolParams,
      undefined,
      built.feeBreakdown,
    ).pipe(
      Effect.mapError((e) => new SendBuildError({reason: e.message, kind: 'build-failed'})),
      Effect.provideService(Decode, rail.decode),
    )

    const change = yield* changeUtxosFromPlan(rail, built.changeOutputs)

    const request: SendQueueRequest = {
      groupId,
      payload: {
        _tag: 'CardanoTx',
        bodyHex: built.bodyHex,
        networkId: rail.config.networkId,
        protocolMagic: rail.config.protocolMagic,
      },
    }

    return {
      reviewed,
      bodyHex: built.bodyHex,
      request,
      tracked: {consumedUtxoIds, change},
      txHash: Tx.bodyHash(built.bodyHex),
      changePlan: {changeOutputs: built.changeOutputs},
    } satisfies SendReview
  })

/** Build a `PendingTx` record from a broadcast result + the send's tracking info. */
export const pendingTxFrom = (txHash: string, tracked: SendReview['tracked'], submittedAt: number): PendingTx => ({
  txHash,
  consumedUtxoIds: tracked.consumedUtxoIds,
  change: tracked.change,
  submittedAt,
})

// ── enhanced send: multiple recipients, multi-asset per recipient, memo ──

/** Split a string into ≤64-BYTE UTF-8 chunks (CIP-20 metadata string limit). */
export const chunkUtf8 = (text: string, maxBytes = 64): readonly string[] => {
  const chunks: string[] = []
  let current = ''
  let bytes = 0
  for (const ch of text) {
    const chBytes = new TextEncoder().encode(ch).length
    if (bytes + chBytes > maxBytes) {
      if (current.length > 0) chunks.push(current)
      current = ch
      bytes = chBytes
    } else {
      current += ch
      bytes += chBytes
    }
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

/** CIP-20 (`674` → `{msg: [...]}`) auxiliary-data CBOR for a memo. */
const buildMemoAux = (memo: string): Effect.Effect<string, CoreError> =>
  Effect.gen(function* () {
    const items = yield* Effect.forEach(chunkUtf8(memo), (c) => Meta.text(c))
    const list = yield* Meta.list(items)
    const key = yield* Meta.text('msg')
    const msgMap = yield* Meta.map([key], [list])
    const metadata = yield* Meta.metadata([674n], [msgMap])
    return yield* Meta.auxiliaryData(metadata)
  })

/** Both are ceilings on the same slot, so the binding one is the smaller. */
const smallestTtl = (a: number | undefined, b: number | undefined): number | undefined =>
  a === undefined ? b : b === undefined ? a : Math.min(a, b)

/** A target's per-asset amounts as the bag the plan engine takes. */
const outputAssets = (amounts: ReadonlyMap<string, bigint>): EvAssets.Assets =>
  EvAssets.fromRecord({
    lovelace: amounts.get(ADA_ID) ?? 0n,
    ...Object.fromEntries([...amounts].filter(([id]) => id !== ADA_ID)),
  })

/**
 * Build an unsigned enhanced send (N recipients × multi-asset) + review IR.
 * When `adaSendAll` is set, a fee-aware second pass gives that recipient
 * `available − fee` exactly (the first pass reserved a cushion), so a "send all"
 * leaves no change instead of burning the cushion into the fee.
 */
export const buildEnhancedSendReview = (
  rail: CardanoRail,
  groupId: string,
  params: {
    readonly targets: readonly ResolvedTarget[]
    readonly memo?: string
    /**
     * Auxiliary data to attach instead of building it from `memo` — for a
     * transaction whose payload is not a message, such as a CIP-146 shared-wallet
     * registration.
     *
     * Wins over `memo` rather than merging with it: aux data holds one metadata
     * map, so two callers writing into it would silently drop one of the two.
     */
    readonly auxiliaryDataHex?: string
    /** The recipient (and reserve) that claimed ADA send-all, for the exact pass. */
    readonly adaSendAll?: {readonly targetIndex: number; readonly reserve: bigint}
    /**
     * Assets minted or burned in this transaction, with the native script
     * authorising each policy.
     *
     * Here rather than in a builder of its own for the same reason
     * `auxiliaryDataHex` is: everything else about a mint-and-distribute *is* a
     * send — the same coin selection, the same witness-count fixed point, the
     * same review IR and signing paths — and a second builder would be a copy of
     * this one that drifts. The minted value the outputs do not take returns as
     * change, which is how a partial distribution keeps its remainder.
     */
    readonly mint?: readonly Plan.PlanMint[]
    /**
     * Upper bound on the slot this transaction may be accepted in.
     *
     * ⚠️ Combined with the authority's own bound by taking the **smaller**: both
     * are ceilings, and a time-locked minting policy whose bound was overwritten
     * by a script wallet's would produce a transaction the ledger refuses.
     */
    readonly ttl?: number
    /**
     * Queued compose legs to build on top of: their inputs are unavailable and
     * their change is spendable, so this send can chain onto them.
     */
    readonly composeOver?: readonly UtxoOverlayEntry[]
  },
): Effect.Effect<SendReview, SendBuildError | CborError> =>
  Effect.gen(function* () {
    const spendable = yield* composeSpendableUtxos(rail, params.composeOver ?? [])
    if (spendable.length === 0) {
      return yield* Effect.fail(new SendBuildError({reason: 'no spendable UTxOs', kind: 'empty-wallet'}))
    }
    if (params.targets.length === 0) {
      return yield* Effect.fail(new SendBuildError({reason: 'no recipients', kind: 'build-failed'}))
    }
    const protocolParams = yield* rail.protocolParams.pipe(
      Effect.mapError((e) => new SendBuildError({reason: e.message, kind: 'build-failed'})),
    )
    const planInputs = spendable.map((utxo) => ({
      txHash: utxoId(utxo).split(':')[0] as TxHashHex,
      index: Number(utxo.index),
      assets: utxo.assets,
    }))
    const auxiliaryDataHex =
      params.auxiliaryDataHex !== undefined
        ? params.auxiliaryDataHex
        : params.memo && params.memo.length > 0
          ? yield* buildMemoAux(params.memo).pipe(
              Effect.mapError((e) => new SendBuildError({reason: `memo: ${e.message}`, kind: 'build-failed'})),
            )
          : undefined

    const authorityFields = authorityPlanFields(rail.account.authority)
    const ttl = smallestTtl(authorityFields.ttl, params.ttl)
    /** Distinct native-script policies this mint authorises; empty for a plain send. */
    const mintScripts = [...new Set((params.mint ?? []).map((m) => m.policyScriptHex).filter((h) => h.length > 0))]
    const planFor = (targets: readonly ResolvedTarget[], signerCount: number) => ({
      inputs: planInputs,
      outputs: targets.map((t) => ({
        addressHex: t.addressHex,
        assets: outputAssets(t.amounts),
        ...(t.datumHex !== undefined ? {datumHex: t.datumHex} : {}),
        ...(t.scriptRefHex !== undefined ? {scriptRefHex: t.scriptRefHex} : {}),
      })),
      changeAddressHex: rail.account.addressHex,
      params: protocolParams,
      ...authorityFields,
      ...(ttl === undefined ? {} : {ttl}),
      ...(params.mint !== undefined && params.mint.length > 0 ? {mint: params.mint} : {}),
      signerCount: signerCount + authorityFields.extraSigners,
      ...(auxiliaryDataHex !== undefined ? {auxiliaryDataHex} : {}),
    })

    const build = (targets: readonly ResolvedTarget[], signerCount: number) =>
      Effect.try({
        try: () => Plan.buildUnsigned(planFor(targets, signerCount)),
        catch: (e) => new SendBuildError(classifyBuildFailure(e)),
      })

    const selectedFrom = (built: Plan.UnsignedPlanTx): readonly UTxO.UTxO[] => {
      const ids = new Set(built.inputs.map((i) => `${i.txHash}:${i.index}`))
      return spendable.filter((u) => ids.has(utxoId(u)))
    }

    /**
     * Build, then re-build until the witness count the fee was sized for matches
     * the one the selected inputs actually need.
     *
     * A fixed point rather than a single pass because the two feed each other:
     * more witnesses means a larger fee, which can pull in another input, which
     * can be at another address. Bounded, and it settles immediately for the
     * single-address case. If it has not settled by the cap, the largest count
     * seen wins — over-paying a few bytes of fee is recoverable, under-paying is
     * a rejected transaction.
     */
    const buildSizedForItsWitnesses = (targets: readonly ResolvedTarget[]) =>
      Effect.gen(function* () {
        let signerCount = 1
        let built = yield* build(targets, signerCount)
        for (let round = 0; round < 4; round++) {
          const needed = distinctSignerCount(selectedFrom(built))
          if (needed <= signerCount) return built
          signerCount = needed
          built = yield* build(targets, signerCount)
        }
        return built
      })

    let built = yield* buildSizedForItsWitnesses(params.targets)

    /**
     * Exact send-all: hand the send-all recipient every lovelace the fee did not
     * need, so change collapses to zero instead of being dust-folded into the fee.
     *
     * A loop, because one pass cannot land it. The bump must be measured against
     * the protocol cost — `built.fee` already has the folded cushion inside it, and
     * subtracting that gave a bump of exactly zero, which is why a send-all shipped
     * paying the whole 1 ADA reserve as fee. Removing the change output then makes
     * the body smaller, so the next fee can be lower and a little folded again; each
     * round hands that remainder over too, and it settles in a round or two.
     */
    const sa = params.adaSendAll
    if (sa !== undefined) {
      const target = params.targets[sa.targetIndex]
      // Lovelace still held back from the recipient — the reserve at first, then
      // whatever the last build left for its fee.
      let held = sa.reserve
      for (let round = 0; round < 4 && target !== undefined; round++) {
        const protocolFee = built.fee - built.feeBreakdown.foldedFromChange
        if (held <= protocolFee) break
        // Always off the ORIGINAL amount, so a round never compounds the last one's bump.
        const amounts = new Map(target.amounts)
        amounts.set(ADA_ID, (amounts.get(ADA_ID) ?? 0n) + sa.reserve - protocolFee)
        const exactTargets = params.targets.map((t, i) =>
          i === sa.targetIndex ? {addressHex: t.addressHex, amounts} : t,
        )
        // Handing over the whole remainder can leave nothing for a fee that grew: a
        // wider output coin costs a few more bytes than this round measured. Keep the
        // build we have when that happens — it is valid, and the review warns about
        // whatever it folded — rather than failing a send that would go through.
        const exact = yield* Effect.either(buildSizedForItsWitnesses(exactTargets))
        if (Either.isLeft(exact)) break
        built = exact.right
        held = protocolFee
      }
    }

    const selected = selectedFrom(built)
    const consumedUtxoIds = selected.map(utxoId)
    const unconfirmed = yield* unconfirmedTxHashesOf(rail)
    const resolvedInputs = resolveOwnInputs(selected, unconfirmed)

    const reviewed = yield* reviewCardanoTx(
      built.bodyHex,
      rail.account.walletContext,
      resolvedInputs,
      protocolParams,
      undefined,
      built.feeBreakdown,
      // The aux we just built, so the review decodes the memo from the same bytes
      // the body's aux-data hash commits to — not from our intent.
      auxiliaryDataHex,
    ).pipe(
      Effect.mapError((e) => new SendBuildError({reason: e.message, kind: 'build-failed'})),
      Effect.provideService(Decode, rail.decode),
    )

    const change = yield* changeUtxosFromPlan(rail, built.changeOutputs)

    // Resolve the signing paths here rather than leaving it to the signing
    // adapter. The adapter re-derives them from `rail.spendableUtxos`, which
    // excludes queued legs — so a leg spending an earlier leg's virtual change
    // is unresolvable there and fails before submit. The build knows exactly
    // which UTxOs it selected, virtual ones included.
    const signing = yield* resolveCardanoSigningPaths(
      built.bodyHex,
      rail.account.keyRegistry,
      resolvedInputs,
      accountScriptContext(rail.account),
    ).pipe(
      Effect.mapError((e) => new SendBuildError({reason: `signing paths: ${e.message}`, kind: 'build-failed'})),
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
        ...(auxiliaryDataHex !== undefined ? {auxHex: auxiliaryDataHex} : {}),
        // ⚠️ The minting policies' scripts only. The signing adapter adds the *authority's* scripts
        // itself, so carrying the build's merged set here would ship each of those twice.
        ...(mintScripts.length > 0 ? {nativeScripts: mintScripts} : {}),
      },
    }
    return {
      reviewed,
      bodyHex: built.bodyHex,
      request,
      tracked: {consumedUtxoIds, change},
      txHash: Tx.bodyHash(built.bodyHex),
      changePlan: {changeOutputs: built.changeOutputs},
    } satisfies SendReview
  })

/**
 * How many of a send's recipients fit in one transaction, and what is left over.
 *
 * `targetsDropped` is non-empty only when the full send exceeded `maxTxSize`. The
 * caller queues `review` as a leg and starts a new send with the remainder, so
 * the pair chains: the queued leg's change funds the next one.
 */
export type SendSizeFit = {
  readonly review: SendReview
  readonly targetsTaken: number
  readonly targetsDropped: readonly ResolvedTarget[]
}

/** True for a build that failed only because the transaction was over the size limit. */
const isTooLarge = (error: SendBuildError | CborError): boolean =>
  '_tag' in error && error._tag === 'SendBuildError' && error.kind === 'too-large'

/**
 * Build a send, splitting it across legs when it does not fit in one transaction.
 *
 * Splittability is decided here rather than in the builder: only **independent
 * payment recipients** may be separated. A single recipient is atomic — one
 * output cannot be halved — so a lone target that overflows fails, which is also
 * what happens when the overflow comes from the *input* side (a wallet whose
 * UTxOs need consolidating first). Neither is silently rewritten.
 *
 * The search walks down from the full set rather than using the library's
 * `fitBySize`: recipients are capped at `MAX_TARGETS`, so this is at most a
 * handful of builds, and every one of them is the *real* pipeline — send-all
 * second pass, memo aux, review IR and signing paths included. A probe over bare
 * plans could land a byte off what we would actually submit.
 */
export const buildSendReviewFittingSize = (
  rail: CardanoRail,
  groupId: string,
  params: {
    readonly targets: readonly ResolvedTarget[]
    readonly memo?: string
    /**
     * Auxiliary data to attach instead of building it from `memo` — for a
     * transaction whose payload is not a message, such as a CIP-146 shared-wallet
     * registration.
     *
     * Wins over `memo` rather than merging with it: aux data holds one metadata
     * map, so two callers writing into it would silently drop one of the two.
     */
    readonly auxiliaryDataHex?: string
    readonly adaSendAll?: {readonly targetIndex: number; readonly reserve: bigint}
    readonly composeOver?: readonly UtxoOverlayEntry[]
  },
): Effect.Effect<SendSizeFit, SendBuildError | CborError> =>
  Effect.gen(function* () {
    const all = yield* Effect.either(buildEnhancedSendReview(rail, groupId, params))
    if (all._tag === 'Right') {
      return {review: all.right, targetsTaken: params.targets.length, targetsDropped: []}
    }
    // Only a size overflow is splittable, and only across several recipients.
    if (!isTooLarge(all.left) || params.targets.length <= 1) return yield* Effect.fail(all.left)

    // A send-all recipient claims "everything left", which has no meaning once the
    // send is split — the remainder would fund the later legs it just emptied.
    if (params.adaSendAll !== undefined) return yield* Effect.fail(all.left)

    for (let take = params.targets.length - 1; take >= 1; take--) {
      const prefix = params.targets.slice(0, take)
      const attempt = yield* Effect.either(buildEnhancedSendReview(rail, groupId, {...params, targets: prefix}))
      if (attempt._tag === 'Right') {
        return {review: attempt.right, targetsTaken: take, targetsDropped: params.targets.slice(take)}
      }
      if (!isTooLarge(attempt.left)) return yield* Effect.fail(attempt.left)
    }
    return yield* Effect.fail(all.left)
  })
