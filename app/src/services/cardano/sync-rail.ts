/**
 * Drive a group's Cardano UTxO fetch from outside React.
 *
 * ⚠️ **The fetch had no trigger of its own.** `service.syncChainWallet` reads a *cached*
 * snapshot and reaches no chain (`services/chain-sync`), and the only callers of
 * `rail.sync` were screens: the portfolio hook, the history hook, the send flow and the
 * dApp builder. So a Cardano balance refreshed when a surface that happened to use it was
 * mounted, and not otherwise — which is why a freshly loaded wallet showed a cached figure
 * until it was forced. The scheduler's own comment already said as much: *"Cardano's rail
 * fetches elsewhere"*. This is that elsewhere, made schedulable.
 *
 * The address set comes from the persisted book through `railAddressSetFromRows`, the same
 * rule `useCardanoRail` applies, so a scheduled sync covers exactly what a screen-driven
 * one does. A wallet whose book is still empty resolves to its primary address alone; that
 * is correct rather than wasteful, because the snapshot records the coverage it was taken
 * under and a later, wider rail refuses a watermark from a narrower one
 * (`docs/CARDANO_DATA_SYNC.md`, gate 5).
 *
 * @module
 */

import type {ChainId} from '@pnyx/config'
import type {WalletImplementation, WalletSource} from '@pnyx/wallet'
import {Effect} from 'effect'

import {logger} from '../../logger'
import {railAddressSetFromRows} from './address-paths'
import {getCardanoDataStore} from './cardano-store'
import {getCardanoRail} from './rail'

const ORIGIN = 'cardano-sync-rail'

export type CardanoRailSyncParams = {
  readonly groupId: string
  readonly chainId: ChainId
  readonly accountIndex: number
  /** The group's primary Cardano address for this account. */
  readonly address: string
}

/**
 * Resolve the rail for one (group, account) and run its sync.
 *
 * `true` when a sync actually ran, so a scheduler tick can report that it did work. Every
 * route to `false` logs its own reason: "did not sync" and "synced and nothing changed"
 * are different facts and a tick that reports the second for the first is undiagnosable.
 *
 * ⚠️ **Ordinary wallets only** — see {@link cardanoRailSyncIsSupported}. A read-only import
 * runs `accountUtxoMode: 'all'` and a CIP-1854 shared wallet's rail is built from compiled
 * scripts, so resolving either one here would build a *second*, differently-scoped rail for
 * the same wallet and fetch under the wrong ownership rule.
 */
export const syncCardanoRail = (params: CardanoRailSyncParams): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const store = getCardanoDataStore()
    if (store === null) {
      logger.debug('no cardano data store bound yet; nothing to sync', {origin: ORIGIN, groupId: params.groupId})
      return false
    }
    const rows = yield* store
      .listAddresses({groupId: params.groupId, chainId: params.chainId, accountIndex: params.accountIndex})
      .pipe(
        Effect.catchAll((e) => {
          // Not fatal: the primary address alone is still a correct, narrower sync, and the
          // coverage stamp keeps the resulting watermark from suppressing a later wider one.
          logger.warn('cardano address book unreadable; syncing the primary address alone', {
            origin: ORIGIN,
            groupId: params.groupId,
            accountIndex: params.accountIndex,
            error: String(e),
          })
          return Effect.succeed([])
        }),
      )
    const set = railAddressSetFromRows(rows, params.address)
    const handle = getCardanoRail(
      params.groupId,
      params.address,
      set.beyondPrimary.length > 0 ? set.beyondPrimary : undefined,
      {accountUtxoMode: 'owned', accountIndex: params.accountIndex, addressPaths: set.paths},
    )
    if (handle === null) {
      logger.debug('no cardano rail for this group; no endpoint configured or no address', {
        origin: ORIGIN,
        groupId: params.groupId,
        accountIndex: params.accountIndex,
      })
      return false
    }
    const rail = yield* Effect.tryPromise(() => handle).pipe(
      Effect.catchAll((e) => {
        logger.warn('cardano rail could not be built for a scheduled sync', {
          origin: ORIGIN,
          groupId: params.groupId,
          accountIndex: params.accountIndex,
          error: String(e),
        })
        return Effect.succeed(null)
      }),
    )
    if (rail === null) return false
    const ran = yield* rail.sync.pipe(
      Effect.as(true),
      Effect.catchAll((e) => {
        logger.warn('scheduled cardano sync failed; the cached balance stands', {
          origin: ORIGIN,
          groupId: params.groupId,
          accountIndex: params.accountIndex,
          error: String(e),
        })
        return Effect.succeed(false)
      }),
    )
    if (ran) {
      // A silent success is the same defect as a silent failure: without this, a schedule
      // that never ran and one that ran clean are the same empty log.
      logger.debug('scheduled cardano sync ran', {
        origin: ORIGIN,
        groupId: params.groupId,
        accountIndex: params.accountIndex,
        addresses: set.beyondPrimary.length + 1,
      })
    }
    return ran
  })

/**
 * Whether {@link syncCardanoRail} may resolve a rail for this wallet.
 *
 * Pure and separate so the exclusion is stated once and testable, rather than inlined in
 * the scheduler where a later reader would take it for an arbitrary guard. Both excluded
 * kinds build their rail by another route and with another ownership mode; a scheduled
 * sync for them is not "slower", it is a different question asked of the same wallet.
 */
export const cardanoRailSyncIsSupported = (wallet: {
  /** The group's `source`, whose read-only spelling is hyphenated. */
  readonly source: WalletSource
  /** The chain's `implementation`, whose read-only spelling is not. Absent ⇒ no chain config. */
  readonly implementation: WalletImplementation | undefined
}): boolean =>
  // Both spellings on purpose: `WalletSource` is 'read-only' and `WalletImplementation` is
  // 'readOnly', and checking only one of them admits the kind it does not name.
  wallet.source !== 'read-only' &&
  wallet.source !== 'multisig' &&
  wallet.implementation !== 'readOnly' &&
  wallet.implementation !== 'cip1854'
