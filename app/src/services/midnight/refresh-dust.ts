/**
 * Re-syncing this wallet's DUST, as something a person can ask for.
 *
 * The sync itself has existed since the rail was built, with exactly one caller: a developer screen.
 * So a DUST state went stale fifteen minutes after somebody opened that screen and there was no way
 * back — which switched self-funded sends off permanently and left the DUST card reporting staleness
 * nobody could act on.
 *
 * ⚠️ **It opens the vault, so it must be user-initiated.** Applying a generation entry needs the dust
 * secret key; a background timer that did this would make the phone ask for a fingerprint because a
 * fiber woke up. That is why the unshielded rail is scheduled and this one is a button.
 *
 * @module
 */

import {type DerivationError, deriveMidnightReceiveAddresses} from '@pnyx/wallet'
import {mnemonicToSeedSync} from '@scure/bip39'
import {Data, Effect} from 'effect'

import {logger} from '../../logger'
import type {VaultError} from '../credential-vault/types'
import {withDustSyncPermit} from './dust-sync-lock'
import {midnightIndexerFor} from './networks'
import {rememberSyncKeys} from './sync-keys'
import type {DustIndexerError} from './wallet/dust-indexer'
import {
  type DustStoreError,
  loadDustHasSpent,
  loadDustRepairs,
  saveDustRepairs,
  saveDustState,
} from './wallet/dust-state-store'
import {type DustSyncError, syncDust} from './wallet/dust-sync'
import {loadUnshieldedCache, type UnshieldedStoreError} from './wallet/unshielded-store'

const ORIGIN = 'midnight-refresh-dust'

/**
 * The refresh could not run — as opposed to running and finding nothing.
 *
 * `spent-before` is a refusal by design and not a fault: a wallet that has spent DUST has successor
 * outputs the per-address feed does not carry, so a rebuilt state would hold unspendable outputs behind
 * a plausible number. `not-configured` is this build having no indexer for the network. Everything else
 * arrives already typed from the store, the indexer or the vault, which is the point of the channel:
 * a cancelled fingerprint and a broken indexer are no longer the same string on the card.
 */
export class RefreshDustError extends Data.TaggedError('RefreshDustError')<{
  readonly cause: 'not-configured' | 'spent-before'
  readonly reason: string
}> {}

export type RefreshDustParams = {
  readonly groupId: string
  readonly accountIndex: number
  /** The Midnight **funds** network, e.g. `preprod`. */
  readonly networkId: string
  /** Localized biometric-prompt title — the vault needs one. */
  readonly biometricPrompt: string
}

export type RefreshedDust = {
  /** Spendable SPECK at the instant it was priced. */
  readonly balance: bigint
  readonly utxos: number
}

/**
 * Re-read this wallet's DUST from the indexer and persist it.
 *
 * Fails with a stated reason rather than returning a partial result: a refresh that quietly did
 * nothing would leave the same stale figure on screen with no way to tell it apart from a fresh one.
 */
export const refreshDust = (
  params: RefreshDustParams,
): Effect.Effect<
  RefreshedDust,
  | RefreshDustError
  | DustSyncError
  | DustIndexerError
  | DustStoreError
  | UnshieldedStoreError
  | VaultError
  | DerivationError
> =>
  Effect.gen(function* () {
    const indexer = midnightIndexerFor(params.networkId)
    if (indexer === null) {
      return yield* new RefreshDustError({
        cause: 'not-configured',
        reason: `no Midnight indexer configured for ${params.networkId}`,
      })
    }

    // ⚠️ **A rebuild is the proven path; the advance exists only for wallets that cannot rebuild.**
    //
    // Rebuilding folds each leaf's final `dtime` in as it inserts it, and that is the state whose
    // generation *and* commitment roots were measured equal to the chain's before a self-funded send
    // landed. Advancing replaces those leaves in place from the indexer's evidence instead, which is
    // newer, heavier and only lightly exercised — a wallet with 37 dtime updates took it and the node
    // refused the spend that followed.
    //
    // So the preference is the other way round from how this first shipped: rebuild unless a rebuild is
    // *unavailable*, which is exactly the wallet that has spent DUST — its outputs have successors at a
    // higher `seq` that the per-address feed does not carry, so reconstructing would hold unspendable
    // outputs behind a plausible number.
    const spentDustBefore = yield* loadDustHasSpent(params.groupId, params.accountIndex)
    // ⚠️ **The rebuild is the path now, for a spent wallet too.** It used to be refused here and an
    // advance preferred; measured on device 2026-08-23, the advance does not reproduce the chain's
    // generation root while a repairing rebuild reproduces both. `syncDust` reinstates each spend's
    // successor from the chain's own `DustSpendProcessed`, so `spentDustBefore` no longer disqualifies
    // anything — it only tells the sync to go and ask which outputs are spent.

    const {createEnclaveMnemonicVault} = yield* Effect.promise(() => import('../credential-vault'))
    const mnemonic = yield* createEnclaveMnemonicVault().retrieve(params.groupId, params.biometricPrompt)
    const seed = mnemonicToSeedSync(mnemonic)
    // Remembered from the prompt the user just answered, so the scheduler can keep this rail current
    // without asking again. In memory only, evicted on lock — see `./sync-keys.ts` for why it is never
    // persisted despite looking like a DUST-only key.
    const {dust: dustRoleKey} = yield* Effect.promise(() =>
      rememberSyncKeys(params.groupId, params.accountIndex, mnemonic, params.networkId),
    )
    const addresses = yield* deriveMidnightReceiveAddresses(seed, {networkId: params.networkId})

    const now = BigInt(Math.floor(Date.now() / 1000))
    // Discovery is sequential in `seq`, so starting from what is already known is what keeps a
    // routine sync to one rebuild instead of one per fee this wallet has ever paid.
    const knownRepairs = yield* loadDustRepairs(params.groupId, params.accountIndex, params.networkId)
    const synced = yield* withDustSyncPermit(
      params.groupId,
      params.accountIndex,
      syncDust({
        indexerUrl: indexer,
        dustAddress: addresses.dust,
        dustRoleKey,
        atUnixSecs: now,
        spentDustBefore,
        repairs: knownRepairs,
      }),
    )

    // The cached unshielded watermark, deliberately the conservative one: behind the truth asks for a
    // refresh too eagerly, ahead of it reports a stale set as current.
    yield* saveDustRepairs(params.groupId, params.accountIndex, synced.repairs)
    const cached = yield* loadUnshieldedCache(params.groupId, params.accountIndex)
    yield* saveDustState(
      params.groupId,
      params.accountIndex,
      synced.state,
      Number(now),
      params.networkId,
      synced.syncTimeSecs,
      synced.cursor,
      cached?.transactionId,
    )

    logger.info('dust re-synced on request', {
      origin: ORIGIN,
      groupId: params.groupId,
      network: params.networkId,
      entries: synced.entries,
      repairsOnRecord: synced.repairs.length,
      // A refresh takes one step too. The scheduler carries on from the list this just persisted.
      moreToRepair: synced.moreToRepair,
      collapses: synced.collapses,
      balance: synced.balance.balance.toString(),
      utxos: synced.balance.utxos,
    })
    return {balance: synced.balance.balance, utxos: synced.balance.utxos}
  })
