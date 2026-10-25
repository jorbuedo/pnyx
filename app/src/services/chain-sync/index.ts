/**
 * Read a chain wallet's cached snapshot and stamp its sync time.
 *
 * **This never talks to a chain, and the name used to claim it did.** It was written around a generic
 * `ChainProvider` port that nothing ever implemented — every registry lookup failed, so the body always
 * fell through to the cached snapshot. The port is gone (`docs/MIDNIGHT_WALLET_ARCHITECTURE.md` §1) and
 * what remains is what always actually happened.
 *
 * It is not dead code: the snapshot it returns is what `applySyncResult` stores, and the dApp connector
 * reads a change address out of that. Both real rails fetch elsewhere — Cardano through
 * `services/cardano/*`, Midnight through `services/midnight/wallet/*`.
 *
 * @module
 */

import type {ChainId} from '@pnyx/config'
import {
  getChainFamily,
  type WalletDataStore,
  type WalletGroupId,
  type WalletManager,
  type WalletSnapshot,
} from '@pnyx/wallet'
import {Effect} from 'effect'
import {logger} from '../../logger'
import {ChainSyncError, type TxFetchMode} from './types'

export {ChainSyncError, TX_FETCH_MODE, type TxFetchMode} from './types'

const getErrorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * The cached snapshot for a chain wallet's selected account, plus a `lastSyncAt` stamp.
 *
 * Syncs all enabled accounts. Returns the selected account's snapshot, or
 * `null` when no enabled accounts exist for this chain and no previously
 * cached snapshot is available in storage.
 *
 * Callers must treat `null` as "wallet not ready for this chain" and MUST NOT
 * insert a placeholder snapshot into state — an empty-addresses snapshot
 * would leak into the UI (stale zero balance).
 */
export const loadCachedChainSnapshot = ({
  walletManager,
  walletStore,
  groupId,
  chainId,
}: {
  readonly walletManager: WalletManager
  readonly walletStore: WalletDataStore
  readonly groupId: WalletGroupId
  readonly chainId: ChainId
  /** 'recent' fetches last 10 transactions, 'all' fetches everything (default). */
  readonly txMode?: TxFetchMode
}): Effect.Effect<WalletSnapshot | null, ChainSyncError> =>
  Effect.gen(function* () {
    const group = yield* walletManager.getGroup(groupId).pipe(
      Effect.mapError(
        (e): ChainSyncError =>
          new ChainSyncError({
            chainId,
            message: `Failed to get group: ${getErrorMessage(e)}`,
            cause: e,
          }),
      ),
    )
    const chainConfig = group.chains.get(chainId)
    if (!chainConfig) {
      return yield* Effect.fail(
        new ChainSyncError({chainId, message: `Chain ${chainId} not found in group ${groupId}`}),
      )
    }

    logger.debug('Reading cached chain snapshot', {
      origin: 'ChainSync',
      chainId,
      family: getChainFamily(chainId),
    })

    const selectedIndex = chainConfig.selectedAccountIndex ?? 0
    const selectedSnapshot = yield* walletStore.loadSnapshot({groupId, chainId, accountIndex: selectedIndex}).pipe(
      Effect.catchAll((e) => {
        logger.warn('Snapshot read failed after sync; the caller sees no snapshot', {
          origin: 'ChainSync',
          groupId,
          chainId,
          accountIndex: selectedIndex,
          error: String(e),
        })
        return Effect.succeed(null)
      }),
    )

    yield* walletStore.updateLastSyncAt({groupId, chainId}).pipe(
      Effect.catchAll((e) => {
        logger.warn('Failed to record the last-sync time', {
          origin: 'ChainSync',
          groupId,
          chainId,
          error: String(e),
        })
        return Effect.void
      }),
    )

    return selectedSnapshot
  })
