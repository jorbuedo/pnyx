/**
 * Build the cNIGHT→DUST registration transactions, and the self-send that activates
 * NIGHT the registration cannot otherwise reach.
 *
 * **Register** mints exactly one auth token and sends it, with the inline
 * `DustMappingDatum`, to the mapping validator's own script address. **Change destination**
 * spends that registration and recreates it with a new datum. **Deregister** spends it and
 * burns the token. All three are authorised the same way: the validator's
 * `check_auth(c_wallet, …)` is satisfied by the account's **stake** key, while the payment
 * key authorises spending the funding inputs, so both are required signers.
 *
 * ⚠️ **`changeDestination` is NOT an operation this validator has, and it never was.** Established by
 * evaluating the real script against real contexts (`aiken uplc unflat` + `uplc eval`, 2026-08-28, after
 * a mainnet attempt was refused). The **spend handler requires the auth token to be BURNED**; it then
 * returns `check_auth(c_wallet, …)`. Proven, against a harness first validated on the register
 * transaction the chain accepted:
 *
 * | context | result |
 * |---|---|
 * | register, as it landed on chain | pass — so the harness is sound |
 * | register, stake key removed from the signers | `Validator returned false` |
 * | spend + **burn** the token | **pass** |
 * | spend + burn, stake key only | pass — so `check_auth` *is* the stake signature |
 * | spend + burn, no signers | `Validator returned false` |
 * | spend + recreate with a new datum, no burn — **what this builder emits** | `Validator returned false` |
 *
 * Neither the output datum, the datum's credential, the destination's length, the output value, the
 * redeemer variant, the input/output shapes nor a withdrawal changes that: none of them touches the mint
 * field, which is what the handler tests.
 *
 * **So changing a destination is `deregister` then `register`** — burn the old token, then mint a new one
 * with the new datum. It cannot be one transaction: both movements are the same policy and the same
 * (empty) asset name, so +1 and −1 net to zero and the burn the handler looks for would not be there.
 * The app already has the multi-leg ceremony this needs. `docs/FOLLOW_UPS.md` item 0a.
 *
 * Until that exists this builder **refuses** the intent rather than emitting a transaction the validator
 * is certain to reject. Nothing was ever paid for the attempts — a script failure under `IsValid True`
 * is refused at submit, so no fee and no collateral — but a guaranteed rejection is not a thing to offer
 * anybody.
 *
 * Unlike the original implementation this does not hand-roll the fee loop, collateral
 * selection or witness sizing — the plan engine owns all three. That matters beyond brevity:
 * the original carried a `FeeTooSmallUTxO` fix for a fee sized from an assumed witness
 * count, which is exactly the class of bug the engine's fee fixed point removes.
 *
 * @module
 */

import {Assets as EvAssets} from '@evolution-sdk/evolution'
import {Plan} from '@evolution-sdk/plan'
import {Bech32, KeyHashHex, ScriptHex, TxHashHex} from '@evolution-sdk/review/Brands'
import {Decode} from '@evolution-sdk/review/Decode'
import type {CborError} from '@evolution-sdk/review/Errors'
import {Address, Body, Data, Tx} from '@pnyx/cardano-core'
import {resolveCardanoSigningPaths, reviewCardanoTx} from '@pnyx/tx-review'
import {type UtxoOverlayEntry, utxoId} from '@pnyx/wallet'
import {Effect, Data as EffectData} from 'effect'
import {accountScriptContext} from '../cardano/account'
import {type BuildFailureKind, classifyBuildFailure} from '../cardano/build-failure'
import type {CardanoRail} from '../cardano/rail'
import {
  changeAssets,
  changeUtxosFromPlan,
  composeSpendableUtxos,
  distinctSignerCount,
  resolveOwnInputs,
  type SendReview,
  unconfirmedTxHashesOf,
} from '../cardano/send-flow'
import type {SendQueueRequest} from '../cardano/send-queue/model'
import {mintRedeemerAlt} from './redeemers'
import {encodeDustRegistrationDatum} from './registration-datum'
import type {DustAddrPayload, TxIn} from './registration-health'
import {
  DUST_AUTH_TOKEN_ASSET_ID,
  DUST_MINT_EX_UNITS,
  DUST_VALIDATOR_ADDRESS,
  DUST_VALIDATOR_MIN_UTXO_LOVELACE,
  DUST_VALIDATOR_SCRIPT_HASH,
  DUST_VALIDATOR_SCRIPT_HEX,
} from './validator'

export class DustBuildError extends EffectData.TaggedError('DustBuildError')<{
  readonly reason: string
  readonly kind: BuildFailureKind | 'empty-wallet' | 'unsupported'
}> {}

/** Plutus `Constr` alternative 0 with no fields — the redeemer the validator ignores. */
const UNIT_REDEEMER_ALT = 0n

export type RegistrationIntent =
  /** Create a registration pointing at `dustPayload`. */
  | {readonly kind: 'register'; readonly dustPayload: DustAddrPayload}
  /** Spend `current` and recreate it pointing at `dustPayload`. */
  | {readonly kind: 'changeDestination'; readonly current: TxIn; readonly dustPayload: DustAddrPayload}
  /** Spend `current` and burn its token. */
  | {readonly kind: 'deregister'; readonly current: TxIn}

const isSpend = (intent: RegistrationIntent): boolean => intent.kind !== 'register'

/**
 * Why this intent cannot be built at all, or `null` when it can.
 *
 * Pure, and checked **before the wallet is read**: an intent the validator has no operation for should
 * not cost a UTxO scan, let alone a transaction nobody can submit. See the module header for the
 * evaluation that settles the one case here.
 */
export const unsupportedIntent = (intent: RegistrationIntent): string | null =>
  intent.kind === 'changeDestination'
    ? 'the mapping validator has no change-destination operation: its spend handler requires the auth ' +
      'token to be burned, so a destination change has to be a deregister followed by a register — ' +
      'use buildDestinationChangeTxs'
    : null

/**
 * The registration transaction for `intent`, as the review ceremony consumes it.
 *
 * `composeOver` layers earlier legs of the same ceremony, so a registration can be built on
 * top of transactions that have not been submitted yet.
 */
/**
 * Change a destination: **deregister, then register** — the two transactions the validator does have.
 *
 * It cannot be one. Both movements are the auth token's own policy with the same (empty) asset name, so
 * a burn and a mint in one transaction net to zero and the burn the spend handler looks for would not be
 * there. The module header has the evaluation that establishes it.
 *
 * ⚠️ **The second leg spends the first's unconfirmed change**, which is what `composeOver` is for, and it
 * is safe here for a reason worth recording: the mint handler's `one_shot_ref` check is derived from the
 * transaction's own inputs rather than pinned to one outref — verified against the real script with
 * inputs the earlier registration never used, and with two inputs rather than one. Had it been pinned,
 * no second registration could ever have been built.
 *
 * The min-ADA works out without new funds: leg 1 releases the 1.586 ADA sitting at the validator and
 * leg 2 puts the same amount back.
 */
export const buildDestinationChangeTxs = (
  rail: CardanoRail,
  groupId: string,
  change: {readonly current: TxIn; readonly dustPayload: DustAddrPayload},
  opts: {readonly resolveCurrentValueHex?: (ref: TxIn) => string | undefined} = {},
): Effect.Effect<readonly SendReview[], DustBuildError | CborError> =>
  Effect.gen(function* () {
    const deregister = yield* buildRegistrationTx(rail, groupId, {kind: 'deregister', current: change.current}, opts)
    const register = yield* buildRegistrationTx(
      rail,
      groupId,
      {kind: 'register', dustPayload: change.dustPayload},
      // Only the overlay: the registration being replaced is gone by now, so there is no current UTxO
      // for the second leg to resolve.
      {composeOver: [deregister.tracked]},
    )
    return [deregister, register]
  })

export const buildRegistrationTx = (
  rail: CardanoRail,
  groupId: string,
  intent: RegistrationIntent,
  opts: {
    readonly resolveCurrentValueHex?: (ref: TxIn) => string | undefined
    /** Earlier legs of the same ceremony, so this one can spend their not-yet-submitted change. */
    readonly composeOver?: readonly UtxoOverlayEntry[]
  } = {},
): Effect.Effect<SendReview, DustBuildError | CborError> =>
  Effect.gen(function* () {
    const refusal = unsupportedIntent(intent)
    if (refusal !== null) {
      return yield* Effect.fail(new DustBuildError({reason: refusal, kind: 'unsupported'}))
    }

    const spendable = yield* composeSpendableUtxos(rail, opts.composeOver ?? [])
    if (spendable.length === 0) {
      return yield* Effect.fail(new DustBuildError({reason: 'no spendable UTxOs', kind: 'empty-wallet'}))
    }
    const params = yield* rail.protocolParams.pipe(
      Effect.mapError((e) => new DustBuildError({reason: e.message, kind: 'build-failed'})),
    )
    const plutusV3CostModel = params.plutusV3CostModel
    if (plutusV3CostModel === undefined) {
      // Without the cost model the script_data_hash cannot be computed, and a transaction
      // with the wrong one is rejected outright. Better to say so than to guess a model.
      return yield* Effect.fail(
        new DustBuildError({reason: 'protocol params carry no Plutus V3 cost model', kind: 'unsupported'}),
      )
    }

    const stakeKeyHash = rail.account.stakeKeyHashHex
    // The datum names a stake credential and `check_auth` looks for its signature, so a
    // wallet watching a bare address has nothing to register.
    if (stakeKeyHash === null) {
      return yield* Effect.fail(
        new DustBuildError({reason: 'this wallet has no stake credential', kind: 'build-failed'}),
      )
    }
    const paymentKeyHash = rail.account.paymentKeyHashHex

    const fundingInputs = spendable.map((utxo) => ({
      txHash: utxoId(utxo).split(':')[0] as TxHashHex,
      index: Number(utxo.index),
      assets: utxo.assets,
    }))

    // Registering mints the token; deregistering burns it; changing the destination spends
    // the old registration and recreates it, so it mints nothing.
    const mint: readonly Plan.PlanMint[] =
      intent.kind === 'register'
        ? [{assetId: DUST_AUTH_TOKEN_ASSET_ID, amount: 1n, policyScriptHex: ''}]
        : intent.kind === 'deregister'
          ? [{assetId: DUST_AUTH_TOKEN_ASSET_ID, amount: -1n, policyScriptHex: ''}]
          : []

    const outputs: Plan.PlanOutput[] =
      intent.kind === 'deregister'
        ? []
        : [
            {
              addressHex: Address.fromBech32Sync(Bech32(DUST_VALIDATOR_ADDRESS)),
              assets: EvAssets.fromRecord({
                lovelace: DUST_VALIDATOR_MIN_UTXO_LOVELACE,
                [DUST_AUTH_TOKEN_ASSET_ID]: 1n,
              }),
              datumHex: encodeDustRegistrationDatum(stakeKeyHash, intent.dustPayload),
            },
          ]

    // Spending the existing registration needs its own value, which the caller resolves
    // from the UTxO it read. Without it the balancer cannot account for the token.
    const mandatoryInputs: Plan.PlanInput[] = []
    if (isSpend(intent)) {
      const current = intent.kind === 'register' ? undefined : intent.current
      const valueHex = current === undefined ? undefined : opts.resolveCurrentValueHex?.(current)
      if (current === undefined || valueHex === undefined) {
        return yield* Effect.fail(
          new DustBuildError({reason: 'the existing registration UTxO could not be resolved', kind: 'build-failed'}),
        )
      }
      mandatoryInputs.push({txHash: TxHashHex(current.txHash), index: current.index, assets: changeAssets(valueHex)})
    }

    const unitRedeemer = yield* Data.constr(UNIT_REDEEMER_ALT, []).pipe(
      Effect.mapError((e) => new DustBuildError({reason: e.message, kind: 'build-failed'})),
    )
    // ⚠️ The mint handler branches on this, and the branches want opposite things — see `./redeemers.ts`.
    // A burn under the unit redeemer takes the registration path, whose first check is a mint of exactly
    // one, and the whole transaction is refused at submit under `MintingScript`.
    const mintRedeemer =
      mint.length === 0
        ? unitRedeemer
        : yield* Data.constr(mintRedeemerAlt((mint[0] as Plan.PlanMint).amount < 0n ? 'burn' : 'mint'), []).pipe(
            Effect.mapError((e) => new DustBuildError({reason: e.message, kind: 'build-failed'})),
          )

    const redeemers: Plan.PlanRedeemer[] = []
    if (mint.length > 0) {
      redeemers.push({
        tag: 1,
        index: 0n,
        dataHex: mintRedeemer,
        mem: DUST_MINT_EX_UNITS.mem,
        steps: DUST_MINT_EX_UNITS.steps,
        mintPolicyHex: DUST_VALIDATOR_SCRIPT_HASH,
      })
    }
    if (isSpend(intent) && intent.kind !== 'register') {
      redeemers.push({
        tag: 0,
        index: 0n,
        dataHex: unitRedeemer,
        mem: DUST_MINT_EX_UNITS.mem,
        steps: DUST_MINT_EX_UNITS.steps,
        spendOutpoint: {txHash: TxHashHex(intent.current.txHash), index: intent.current.index},
      })
    }

    // Both keys are required signers: the stake key is what `check_auth` looks for, the
    // payment key authorises the funding inputs.
    const requiredSignersHex = yield* Body.requiredSigners([KeyHashHex(paymentKeyHash), KeyHashHex(stakeKeyHash)]).pipe(
      Effect.mapError((e) => new DustBuildError({reason: e.message, kind: 'build-failed'})),
    )

    const built = yield* Effect.try({
      try: () =>
        Plan.buildUnsigned({
          inputs: fundingInputs,
          ...(mandatoryInputs.length > 0 ? {mandatoryInputs} : {}),
          outputs,
          changeAddressHex: rail.account.addressHex,
          params,
          ...(mint.length > 0 ? {mint} : {}),
          bodyExtra: [[14, requiredSignersHex]],
          plutus: {
            scriptsV3: [ScriptHex(DUST_VALIDATOR_SCRIPT_HEX)],
            redeemers,
            costModels: [{language: 2, costs: plutusV3CostModel}],
          },
          // Payment keys for the inputs, plus the stake key. The engine converges the fee
          // on this, so an under-count is what used to produce FeeTooSmallUTxO.
          signerCount: distinctSignerCount(spendable) + 1,
        }),
      catch: (e) => new DustBuildError(classifyBuildFailure(e)),
    })

    const selectedIds = new Set(built.inputs.map((i) => `${i.txHash}:${i.index}`))
    const selected = spendable.filter((u) => selectedIds.has(utxoId(u)))
    const unconfirmed = yield* unconfirmedTxHashesOf(rail)
    const resolvedInputs = resolveOwnInputs(selected, unconfirmed)

    const reviewed = yield* reviewCardanoTx(
      built.bodyHex,
      rail.account.walletContext,
      resolvedInputs,
      params,
      undefined,
      built.feeBreakdown,
    ).pipe(
      Effect.mapError((e) => new DustBuildError({reason: e.message, kind: 'build-failed'})),
      Effect.provideService(Decode, rail.decode),
    )

    const signing = yield* resolveCardanoSigningPaths(
      built.bodyHex,
      rail.account.keyRegistry,
      resolvedInputs,
      accountScriptContext(rail.account),
    ).pipe(
      Effect.mapError((e) => new DustBuildError({reason: `signing paths: ${e.message}`, kind: 'build-failed'})),
      Effect.provideService(Decode, rail.decode),
    )

    // The body commits to the script witnesses through its script_data_hash, so a payload
    // that carries the body without them assembles to a transaction the node rejects
    // (ScriptIntegrityHashMismatch + MissingScriptWitnessesUTXOW). Every intent here either
    // mints or spends under the validator, so the entries must exist.
    if (built.witnessExtra.length === 0) {
      return yield* Effect.fail(
        new DustBuildError({reason: 'the build produced no script witnesses', kind: 'build-failed'}),
      )
    }

    const change = yield* changeUtxosFromPlan(rail, built.changeOutputs)
    const request: SendQueueRequest = {
      groupId,
      payload: {
        _tag: 'CardanoTx',
        bodyHex: built.bodyHex,
        networkId: rail.config.networkId,
        protocolMagic: rail.config.protocolMagic,
        witnessExtra: built.witnessExtra,
        precomputedSigningPaths: signing.signingPaths,
        precomputedRequiredKeyHashes: signing.requiredKeyHashes,
      },
    }

    return {
      reviewed,
      bodyHex: built.bodyHex,
      request,
      tracked: {consumedUtxoIds: selected.map(utxoId), change},
      txHash: Tx.bodyHash(built.bodyHex),
      changePlan: {changeOutputs: built.changeOutputs},
    } satisfies SendReview
  })
