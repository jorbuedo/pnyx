/**
 * Staking-flow orchestration: unsigned delegation / unstake / withdraw txs over
 * the rail's spendable UTxO view, mirroring `send-flow.ts` — the review screen
 * and ceremony signing consume the same `{reviewed, request, tracked}` shape.
 *
 * Cert choice is `decideDelegation`'s job (see `state.ts`); this module encodes
 * the chosen cert via the `Certs` facade, hands the plan engine the matching
 * deposit delta, and forces the Conway zero-reward rule on deregistration
 * (pending rewards are withdrawn in the same tx or the ledger rejects it).
 *
 * @module
 */

import type {UTxO} from '@evolution-sdk/evolution'
import {RewardAddress} from '@evolution-sdk/evolution'
import {Plan} from '@evolution-sdk/plan'
import type {TxHashHex} from '@evolution-sdk/review/Brands'
import {Decode} from '@evolution-sdk/review/Decode'
import type {CborError} from '@evolution-sdk/review/Errors'
import {Certs} from '@pnyx/cardano-core'
import type {SigningRequest} from '@pnyx/signing-service'
import {type ReviewedTransaction, reviewCardanoTx} from '@pnyx/tx-review'
import {utxoId} from '@pnyx/wallet'
import {Data, Effect} from 'effect'
import type {DRepTarget} from '../../cardano-pool-drep/drep-id'
import {authorityPlanFields, authorityStakeContext, type SpendAuthority} from '../account'
import {type BuildFailureKind, classifyBuildFailure} from '../build-failure'
import type {CardanoRail} from '../rail'
import {changeUtxosFromPlan, distinctSignerCount, resolveOwnInputs} from '../send-flow'
import type {SignerKind} from '../signer-kind'
import {delegationCertSteps} from './delegation-certs'
import {poolKeyHashHex} from './pool-id'
import {
  actionRegisters,
  type DelegationSelection,
  decideDelegation,
  type StakeAccountState,
  stakeStateFromAccountInfo,
} from './state'

export class StakeBuildError extends Data.TaggedError('StakeBuildError')<{
  readonly reason: string
  readonly kind: BuildFailureKind | 'empty-wallet' | 'nothing-to-do' | 'unavailable'
}> {}

export type StakeReview = {
  readonly reviewed: ReviewedTransaction
  readonly bodyHex: string
  readonly request: SigningRequest
  /** Pending-tx overlay entry to register on a successful broadcast. */
  readonly tracked: {readonly consumedUtxoIds: readonly string[]; readonly change: readonly UTxO.UTxO[]}
}

/**
 * The wallet's reward (stake) address, bech32 + raw hex.
 *
 * Taken from the account rather than re-encoded from its stake key hash: a
 * script account's stake credential is a script hash and needs the script
 * reward encoding, so re-encoding here would quietly build the wrong address
 * for one kind of wallet.
 */
export const rewardAddress = (rail: CardanoRail): {readonly bech32: string; readonly hex: string} | null =>
  rail.account.rewardAddressBech32 === null || rail.account.rewardAddressHex === null
    ? null
    : {bech32: rail.account.rewardAddressBech32, hex: rail.account.rewardAddressHex}

/**
 * The stake credential every certificate is built against, or a typed failure.
 *
 * A wallet watching a bare address has none: an enterprise address carries no stake
 * credential, so there is no account to register, delegate or unregister. Refusing
 * here keeps that a stated outcome rather than a certificate built over `null`.
 */
const stakeCredential = (rail: CardanoRail): Effect.Effect<string, StakeBuildError> =>
  rail.account.stakeKeyHashHex === null
    ? Effect.fail(new StakeBuildError({reason: 'this wallet has no stake credential', kind: 'unavailable'}))
    : Effect.succeed(rail.account.stakeKeyHashHex)

/**
 * Read the stake account's on-chain state. Fails `unavailable` when the rail's
 * provider has no account indexing (`accountInfo` is an optional port method).
 */
export const fetchStakeAccountState = (rail: CardanoRail): Effect.Effect<StakeAccountState, StakeBuildError> => {
  const accountInfo = rail.chain.getAccountInfo
  const reward = rewardAddress(rail)
  if (accountInfo === undefined) {
    return Effect.fail(new StakeBuildError({reason: 'provider has no account indexing', kind: 'unavailable'}))
  }
  if (reward === null) {
    return Effect.fail(new StakeBuildError({reason: 'this wallet has no stake account', kind: 'unavailable'}))
  }
  return accountInfo(RewardAddress.RewardAddress.make(reward.bech32)).pipe(
    Effect.map(stakeStateFromAccountInfo),
    Effect.mapError((e) => new StakeBuildError({reason: e.message, kind: 'unavailable'})),
  )
}

/** `pool1…` bech32 → 28-byte pool key hash hex. */
export const poolHashHexFromBech32 = (poolIdBech32: string): Effect.Effect<string, StakeBuildError> => {
  const hex = poolKeyHashHex(poolIdBech32)
  return hex === null
    ? Effect.fail(new StakeBuildError({reason: `not a pool id: ${poolIdBech32}`, kind: 'build-failed'}))
    : Effect.succeed(hex)
}

const drepCertArgs = (drep: DRepTarget): {readonly kind: Certs.DRepKind; readonly hashHex: string} =>
  drep.kind === 'key' || drep.kind === 'script'
    ? {kind: drep.kind, hashHex: drep.hashHex}
    : {kind: drep.kind, hashHex: ''}

type PlannedParts = {
  readonly certificates?: readonly string[]
  readonly withdrawals?: readonly {readonly rewardAcctHex: string; readonly amount: bigint}[]
  readonly deposit?: bigint
}

/**
 * Whether this account's stake credential is a script hash.
 *
 * Read from the authority rather than by inspecting `stakeKeyHashHex`, which is
 * 28 bytes either way and says nothing about which it is.
 */
const stakeCredIsScript = (rail: CardanoRail): boolean => rail.account.authority.kind === 'script'

/**
 * How many vkey witnesses a staking transaction will carry, which is what the
 * fee has to be sized for.
 *
 * A key wallet pays one witness per distinct input address plus one for its
 * stake key. A script wallet owes a *quorum* on each side instead: the payment
 * quorum summed over every index it may spend at, and the delegation script's
 * own on top. Counting one apiece there leaves the fee short by exactly the
 * signatures that arrive last — so the transaction would fail when the final
 * co-signer signed rather than when it was built, which is the worst possible
 * moment to discover it.
 *
 * A script wallet's answer does not depend on the selection, so the caller's
 * fixed point settles on the first round.
 */
export const stakeWitnessBudget = (authority: SpendAuthority, inputAddresses: number): number => {
  const stake = authorityStakeContext(authority)
  if (stake === undefined) return inputAddresses + 1
  // `extraSigners` is the payment quorum over every index, less the one an
  // ordinary build already assumes — so adding it back gives the whole payment side.
  return authorityPlanFields(authority).extraSigners + 1 + stake.requiredSigners
}

/** Shared plan→review→request assembly for all three staking txs. */
const buildStakeReview = (
  rail: CardanoRail,
  groupId: string,
  parts: PlannedParts,
): Effect.Effect<StakeReview, StakeBuildError | CborError> =>
  Effect.gen(function* () {
    const spendable = yield* rail.spendableUtxos
    if (spendable.length === 0) {
      return yield* Effect.fail(new StakeBuildError({reason: 'no spendable UTxOs', kind: 'empty-wallet'}))
    }
    const protocolParams = yield* rail.protocolParams.pipe(
      Effect.mapError((e) => new StakeBuildError({reason: e.message, kind: 'build-failed'})),
    )

    const planInputs = spendable.map((utxo) => ({
      txHash: utxoId(utxo).split(':')[0] as TxHashHex,
      index: Number(utxo.index),
      assets: utxo.assets,
    }))

    const {extraSigners: _budgetedSeparately, ...authorityFields} = authorityPlanFields(rail.account.authority)
    const stake = authorityStakeContext(rail.account.authority)
    // Every transaction this builds names the stake credential — a certificate or
    // a withdrawal — so a script account owes its delegation script here on top of
    // the payment scripts its inputs need. An ordinary send must NOT carry it: the
    // ledger rejects a native script nothing in the transaction requires.
    const nativeScripts =
      stake === undefined ? undefined : [...(authorityFields.nativeScripts ?? []), stake.nativeScriptHex]

    // Sync builder: the Effect wrapper flattens the cause's tag away.
    const build = (signerCount: number) =>
      Effect.try({
        try: () =>
          Plan.buildUnsigned({
            inputs: planInputs,
            outputs: [],
            changeAddressHex: rail.account.addressHex,
            params: protocolParams,
            ...authorityFields,
            ...(nativeScripts !== undefined ? {nativeScripts} : {}),
            ...(parts.certificates !== undefined ? {certificates: parts.certificates} : {}),
            ...(parts.withdrawals !== undefined ? {withdrawals: parts.withdrawals} : {}),
            ...(parts.deposit !== undefined ? {deposit: parts.deposit} : {}),
            signerCount,
          }),
        catch: (e) => new StakeBuildError(classifyBuildFailure(e)),
      })
    const selectedFrom = (b: Plan.UnsignedPlanTx): readonly UTxO.UTxO[] => {
      const ids = new Set(b.inputs.map((i) => `${i.txHash}:${i.index}`))
      return spendable.filter((u) => ids.has(utxoId(u)))
    }

    // Sized as a fixed point, since a larger fee can pull in another input. A
    // hardcoded 2 under-sized it for any wallet whose coin selection reached past
    // its primary address.
    const budgetFor = (inputAddresses: number) => stakeWitnessBudget(rail.account.authority, inputAddresses)
    let signerCount = budgetFor(1)
    let built = yield* build(signerCount)
    for (let round = 0; round < 4; round++) {
      const needed = budgetFor(distinctSignerCount(selectedFrom(built)))
      if (needed <= signerCount) break
      signerCount = needed
      built = yield* build(signerCount)
    }

    const selected = selectedFrom(built)
    const consumedUtxoIds = selected.map(utxoId)
    const resolvedInputs = resolveOwnInputs(selected, new Set())

    const reviewed = yield* reviewCardanoTx(
      built.bodyHex,
      rail.account.walletContext,
      resolvedInputs,
      protocolParams,
      undefined,
      built.feeBreakdown,
    ).pipe(
      Effect.mapError((e) => new StakeBuildError({reason: e.message, kind: 'build-failed'})),
      Effect.provideService(Decode, rail.decode),
    )

    const change = yield* changeUtxosFromPlan(rail, built.changeOutputs)

    // The delegation script only, not the plan's whole set: `applyAuthorityToRequest`
    // appends the payment scripts on the way to the signer, and a script sent twice
    // is a witness set the ledger will not accept. Each layer contributes what it
    // alone knows — the builder that this transaction names the stake credential,
    // the authority that this account spends from script addresses.
    const request: SigningRequest = {
      groupId,
      payload: {
        _tag: 'CardanoTx',
        bodyHex: built.bodyHex,
        networkId: rail.config.networkId,
        protocolMagic: rail.config.protocolMagic,
        ...(stake === undefined ? {} : {nativeScripts: [stake.nativeScriptHex]}),
      },
    }

    return {reviewed, bodyHex: built.bodyHex, request, tracked: {consumedUtxoIds, change}} satisfies StakeReview
  })

/**
 * Build the delegation tx for the user's pool/DRep selection: one Conway cert
 * chosen by `decideDelegation` (combined 10–13 when registering or changing
 * both), depositing `keyDeposit` iff the stake key registers in this tx.
 */
export const buildDelegationReview = (
  rail: CardanoRail,
  groupId: string,
  state: StakeAccountState,
  selection: DelegationSelection,
  /**
   * Who will sign this. Required, not optional with a default: it decides whether the transaction
   * carries a combined certificate, and a caller that guessed `'software'` for a hardware wallet
   * would build a transaction the device refuses at the end of the funnel.
   */
  signer: SignerKind | null,
): Effect.Effect<StakeReview, StakeBuildError | CborError> =>
  Effect.gen(function* () {
    const action = decideDelegation(state, selection)
    if (action.kind === 'noop') {
      return yield* Effect.fail(
        new StakeBuildError({reason: 'selection matches the current delegation', kind: 'nothing-to-do'}),
      )
    }
    const protocolParams = yield* rail.protocolParams.pipe(
      Effect.mapError((e) => new StakeBuildError({reason: e.message, kind: 'build-failed'})),
    )
    const keyDeposit = protocolParams.keyDeposit
    const cred = yield* stakeCredential(rail)
    // Every `Certs.*` builder takes this last and defaults it to `false`, so an
    // omitted argument encodes a *key* credential over whatever 28 bytes it was
    // given. For a shared wallet those bytes are a script hash, and the result is
    // a well-formed certificate delegating an account that does not exist —
    // nothing rejects it until the chain does.
    const isScript = stakeCredIsScript(rail)

    // ⚠️ A hardware or script signer gets the atomic certificates, never the combined Conway types:
    // CIP-21 forbids those in a hardware-wallet transaction and both device converters refuse
    // them. `delegation-certs.ts` has the reasoning and the ordering rule.
    const certs = yield* Effect.forEach(delegationCertSteps(action, signer), (step) =>
      Effect.gen(function* () {
        switch (step.kind) {
          case 'register':
            return yield* Certs.registration(cred, keyDeposit, isScript)
          case 'delegate-stake': {
            const pool = yield* poolHashHexFromBech32(step.poolId)
            return yield* Certs.stakeDelegation(cred, pool, isScript)
          }
          case 'delegate-vote': {
            const drep = drepCertArgs(step.drep)
            return yield* Certs.voteDelegation(cred, drep.kind, drep.hashHex, isScript)
          }
          case 'register-delegate-stake': {
            const pool = yield* poolHashHexFromBech32(step.poolId)
            return yield* Certs.stakeRegDelegation(cred, pool, keyDeposit, isScript)
          }
          case 'register-delegate-vote': {
            const drep = drepCertArgs(step.drep)
            return yield* Certs.voteRegDelegation(cred, drep.kind, keyDeposit, drep.hashHex, isScript)
          }
          case 'delegate-stake-vote': {
            const pool = yield* poolHashHexFromBech32(step.poolId)
            const drep = drepCertArgs(step.drep)
            return yield* Certs.stakeVoteDelegation(cred, pool, drep.kind, drep.hashHex, isScript)
          }
          case 'register-delegate-stake-vote': {
            const pool = yield* poolHashHexFromBech32(step.poolId)
            const drep = drepCertArgs(step.drep)
            return yield* Certs.stakeVoteRegDelegation(cred, pool, drep.kind, keyDeposit, drep.hashHex, isScript)
          }
        }
      }),
    ).pipe(
      Effect.mapError((e) =>
        e instanceof StakeBuildError ? e : new StakeBuildError({reason: e.message, kind: 'build-failed'}),
      ),
    )

    return yield* buildStakeReview(rail, groupId, {
      certificates: certs,
      ...(actionRegisters(action) ? {deposit: keyDeposit} : {}),
    })
  })

/**
 * Deregister the stake key (Conway `unreg_cert`, deposit refunded). Pending
 * rewards are withdrawn in the SAME tx — the ledger rejects deregistration
 * with a non-zero reward balance.
 */
export const buildUnstakeReview = (
  rail: CardanoRail,
  groupId: string,
  state: StakeAccountState,
): Effect.Effect<StakeReview, StakeBuildError | CborError> =>
  Effect.gen(function* () {
    if (!state.registered) {
      return yield* Effect.fail(new StakeBuildError({reason: 'stake key is not registered', kind: 'nothing-to-do'}))
    }
    const protocolParams = yield* rail.protocolParams.pipe(
      Effect.mapError((e) => new StakeBuildError({reason: e.message, kind: 'build-failed'})),
    )
    // The refund must equal the deposit actually held. Backends omit it only
    // for registrations made at the protocol `keyDeposit` (pre-Conway certs
    // carry no explicit amount), so the protocol value IS that deposit.
    const refund = state.deposit ?? protocolParams.keyDeposit
    const reward = rewardAddress(rail)
    const cert = yield* Certs.unregistration(yield* stakeCredential(rail), refund, stakeCredIsScript(rail)).pipe(
      Effect.mapError((e) => new StakeBuildError({reason: e.message, kind: 'build-failed'})),
    )
    return yield* buildStakeReview(rail, groupId, {
      certificates: [cert],
      deposit: -refund,
      ...(state.rewardsAvailable > 0n && reward !== null
        ? {withdrawals: [{rewardAcctHex: reward.hex, amount: state.rewardsAvailable}]}
        : {}),
    })
  })

/** Withdraw the claimable rewards into the wallet (change output). */
export const buildWithdrawReview = (
  rail: CardanoRail,
  groupId: string,
  state: StakeAccountState,
): Effect.Effect<StakeReview, StakeBuildError | CborError> =>
  state.rewardsAvailable <= 0n || rewardAddress(rail) === null
    ? Effect.fail(new StakeBuildError({reason: 'no rewards available', kind: 'nothing-to-do'}))
    : buildStakeReview(rail, groupId, {
        withdrawals: [{rewardAcctHex: (rewardAddress(rail) as {hex: string}).hex, amount: state.rewardsAvailable}],
      })
