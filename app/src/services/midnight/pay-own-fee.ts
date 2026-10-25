/**
 * Paying a transaction's Midnight fee from this wallet's own DUST, instead of the sponsor's.
 *
 * The host half of `@pnyx/midnight-native`'s `walletPayFeeFromDust`. Unlike `./send-self-funded.ts`
 * this does not build the transaction — it takes one that already exists, from wherever, and pays for
 * it. A dApp's over the connector, an agent's over MCP, or one this app built for another wallet are
 * all the same input here.
 *
 * ⚠️ **The result is sealed, which changes how it must be submitted.** A sponsored transaction goes out
 * pre-binding so the service can merge its fee and bind it; this one is finished, and
 * `./submit-sealed.ts` takes it to the node directly. A caller that hands a sealed transaction to the
 * sponsor gets a refusal about a shape, not about a fee.
 *
 * ⚠️ **Nothing is submitted here, and that is what keeps a fallback safe.** Until the bytes reach a
 * node, a failure costs nothing and the caller may still let the sponsor pay — which is the whole point
 * of `prefer-self` in `./fee-payer.ts`. After submission it cannot, because the same transaction would
 * be paid for twice.
 *
 * @module
 */

import {Roles} from '@midnight-ntwrk/wallet-sdk-hd'
import {walletPayFeeFromDust} from '@pnyx/midnight-native'
import {deriveMidnightRoleKey} from '@pnyx/wallet'
import {mnemonicToSeedSync} from '@scure/bip39'
import {Effect} from 'effect'

import {logger} from '../../logger'
import {ensureDustArtifacts} from '../pnyx-artifacts'
import {MidnightBuildError} from './build-failure'
import {runMidnight} from './effect-boundary'
import {rememberSyncKeysForScheduler} from './sync-keys'
import {loadDustStateForSpend} from './wallet/dust-state-store'

const ORIGIN = 'midnight-pay-own-fee'

/** An hour, matching every other builder here. Far-future TTLs are refused as `Custom error: 182`. */
const TTL_SECONDS = 3600

export type PayOwnFeeParams = {
  readonly groupId: string
  readonly accountIndex: number
  /** A proven, signature-enabled, **pre-binding** transaction. A sealed one cannot be paid for. */
  readonly transaction: Uint8Array
  readonly networkId: string
  /** Localized biometric-prompt title — the vault needs one. */
  readonly biometricPrompt: string
}

export type PaidOwnFee = {
  /** Sealed and submittable as-is, through `./submit-sealed.ts`. */
  readonly transaction: Uint8Array
  /** ⚠️ Record this as a **pending** spend once submitted, never before — the fee took an output. */
  readonly dustState: Uint8Array
  /** What the transaction costs, in SPECK. */
  readonly fee: bigint
  /** What this wallet contributed. Below `fee` only when the transaction already carried DUST. */
  readonly paid: bigint
  /** Read before the seal, because they cannot be recovered from the sealed bytes. */
  readonly identifiers: readonly string[]
  /** When the fee intent expires, for the pending-spend record. */
  readonly expiresAt: number
}

/**
 * Pay `transaction`'s fee from this wallet's DUST and return it sealed. **Sends nothing.**
 *
 * Throws with a stated reason rather than falling back — falling back is `./fee-payer.ts`'s decision
 * and the caller's, not this function's. Because nothing has been sent, every throw is safe to recover
 * from.
 */
export const payOwnFee = async (params: PayOwnFeeParams): Promise<PaidOwnFee> => {
  const {createEnclaveMnemonicVault} = await import('../credential-vault')
  const mnemonic = await Effect.runPromise(
    createEnclaveMnemonicVault().retrieve(params.groupId, params.biometricPrompt),
  )
  const seed = mnemonicToSeedSync(mnemonic)
  // The vault is open, so the scheduler can be given what it needs to keep DUST current without
  // asking again. Same reason as every other builder that unlocks it.
  void rememberSyncKeysForScheduler(params.groupId, params.accountIndex, mnemonic, params.networkId)
  const dustRoleKey = await Effect.runPromise(deriveMidnightRoleKey(seed, Roles.Dust, {account: params.accountIndex}))

  // Before the state is read, because a cold artifact cache takes seconds and the state and its block
  // time must be read as late and as close together as possible — see `send-self-funded.ts`.
  const {artifactDir, paramsDir} = await ensureDustArtifacts()

  // ⚠️ **State and block time as a pair.** A dust spend proof commits to our tree roots and the node
  // looks its own up under the timestamp the spend declares, so a state from one sync carrying another
  // sync's timestamp resolves to roots the proof never used — reported as `InvalidDustSpendProof`.
  const dust = await runMidnight(loadDustStateForSpend(params.groupId, params.accountIndex, params.networkId))
  if (dust === undefined) {
    // Distinct from "holds no DUST": nobody has looked, and the fix is a sync rather than funding.
    throw new MidnightBuildError({
      cause: 'not-ready',
      reason: 'this wallet has not synced its DUST yet, so it cannot pay this fee',
    })
  }
  const {state: dustState, blockTimeSecs: ctimeSecs} = dust
  if (ctimeSecs === 0) {
    throw new MidnightBuildError({
      cause: 'not-ready',
      reason: 'this wallet’s DUST state has no block time — refresh its DUST before paying with it',
    })
  }

  const now = Math.floor(Date.now() / 1000)
  const paid = await walletPayFeeFromDust({
    transaction: params.transaction,
    dustState,
    dustRoleKey,
    ctimeSecs,
    ttlSecs: now + TTL_SECONDS,
    artifactDir,
    paramsDir,
  })
  logger.info('a transaction’s fee was paid from this wallet’s DUST', {
    origin: ORIGIN,
    network: params.networkId,
    was: params.transaction.length,
    now: paid.transaction.length,
    fee: paid.fee.toString(),
    paid: paid.paid.toString(),
    segment: paid.segment,
    identifiers: paid.identifiers,
  })
  return {
    transaction: paid.transaction,
    dustState: paid.dustState,
    fee: paid.fee,
    paid: paid.paid,
    identifiers: paid.identifiers,
    expiresAt: now + TTL_SECONDS,
  }
}
