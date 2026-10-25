/**
 * Pure reconciliation of chain sync states after a pull-to-refresh.
 *
 * Separated from WalletProvider so it can be tested without the React runtime.
 *
 * @module
 */

import type {ChainSyncState, ChainWalletKey} from '@pnyx/wallet'

/** Outcome of one chain's manual refresh sync. */
export type ChainSyncOutcome = {readonly ok: true} | {readonly ok: false; readonly message: string}

/**
 * Merge the outcome of a manual `syncWallet` refresh into the previous sync
 * states.
 *
 * A chain that synced (`ok`) is reset to `idle` (success is reflected
 * immediately rather than waiting for the next scheduler poll). A chain whose
 * sync failed — e.g. the device is offline — is set to `error` with *this
 * attempt's* message, so the connectivity classifier sees the fresh failure.
 * Forcing it to `idle` erased the offline signal and flipped the connectivity
 * banner off after a failed refresh; keeping a stale prior `lastError` could
 * likewise leave a chain misclassified as a server error after going offline
 * The scheduler poll still owns the chain's status between refreshes.
 *
 * `lastChanged` is bumped for every chain so downstream consumers
 * (usePortfolioAssets, useAggregateBalance) detect the refresh and re-fetch.
 */
export const reconcileRefreshedSyncStates = (params: {
  readonly prev: ReadonlyMap<ChainWalletKey, ChainSyncState>
  readonly groupId: string
  readonly chainIds: readonly string[]
  readonly results: readonly ChainSyncOutcome[]
  readonly now: number
}): ReadonlyMap<ChainWalletKey, ChainSyncState> => {
  const {prev, groupId, chainIds, results, now} = params
  const next = new Map(prev)
  chainIds.forEach((chainId, i) => {
    const key = `${groupId}:${chainId}` as ChainWalletKey
    const existing = next.get(key) ?? {status: 'idle' as const}
    const result = results[i]
    next.set(
      key,
      result?.ok === false
        ? {...existing, status: 'error', lastChanged: now, lastError: result.message || existing.lastError}
        : {...existing, status: 'idle', lastChanged: now, lastError: undefined},
    )
  })
  return next
}
