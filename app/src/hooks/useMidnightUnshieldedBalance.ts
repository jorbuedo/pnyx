/**
 * The selected funds group's unshielded Midnight balance for one address.
 *
 * Read from the **live feed**, which holds the indexer subscription open for as long as something is
 * rendering it. There is no fetch to make here — the indexer has no by-address query for unshielded
 * UTxOs — so the feed is the rail's real shape, and a balance is what it currently says.
 *
 * ⚠️ **This one needs no vault, and the shielded one does.** Unshielded UTxOs are addressed in the
 * clear, so watching them costs a socket, not a biometric prompt. That is why this can run on screen
 * focus while a shielded refresh must be user-initiated.
 *
 * ⚠️ **Absent is not zero.** `totals` is `null` until the feed has published for this address; an empty
 * map means it published, and there is nothing. Rendering `0 NIGHT` for "never read" would state as
 * fact something no one checked.
 *
 * @module
 */

import {Effect, Either} from 'effect'
import {useCallback, useMemo, useState} from 'react'
import {logger} from '../logger'
import {useConfig, useWalletList} from '../providers'
import {midnightFundsNetwork} from '../services/midnight/networks'
import {syncUnshieldedWallet} from '../services/midnight/wallet/unshielded'
import {unshieldedUtxoId} from '../services/midnight/wallet/unshielded-pending-store'
import {totalsByToken, type UnshieldedUtxo} from '../services/midnight/wallet/unshielded-utxo-set'
import {useUnshieldedFeed} from './useUnshieldedFeed'

const ORIGIN = 'midnight-unshielded-balance'

export type UnshieldedBalanceState = {
  /** Atomic units per token type. `null` while unknown — never conflated with an empty wallet. */
  readonly totals: ReadonlyMap<string, bigint> | null
  /**
   * The UTxOs themselves, for a surface that lists them rather than totalling them. `null` under the same
   * rule as `totals`: unknown is not empty.
   */
  readonly utxos: readonly UnshieldedUtxo[] | null
  readonly utxoCount: number | null
  readonly syncing: boolean
  /** Why the last attempt could not run, or `null`. Kept apart from an empty balance. */
  readonly unavailable: string | null
  /**
   * Force a read now.
   *
   * Mostly redundant under a live feed — it is already listening — and `syncUnshieldedWallet` defers to
   * the feed rather than opening a competing socket. Kept because a pull-to-refresh that does nothing
   * is worse than one that confirms, and because it is the path when no feed is up yet.
   */
  readonly refresh: () => Promise<void>
}

export const useMidnightUnshieldedBalance = (address: string | undefined): UnshieldedBalanceState => {
  const {network} = useConfig()
  const {selectedWalletGroup, selectedAccountIndex} = useWalletList()
  const groupId = selectedWalletGroup?.groupId
  const {live} = useUnshieldedFeed(address)
  const [syncing, setSyncing] = useState(false)
  const [unavailable, setUnavailable] = useState<string | null>(null)

  /**
   * Derived here, never in the store subscription's selector.
   *
   * `useSyncExternalStore` compares snapshots by identity, so a selector building a fresh Map every
   * call is an infinite render loop rather than a slow render. `useKeyedServiceState` hands back the
   * stored projection verbatim and the shaping happens on the result — see `useServiceState`'s header.
   */
  const totals = useMemo(
    () =>
      live === undefined ? null : totalsByToken(new Map(live.spendable.map((utxo) => [unshieldedUtxoId(utxo), utxo]))),
    [live],
  )

  const refresh = useCallback(async () => {
    if (groupId === undefined || address === undefined) return
    const fundsNetwork = midnightFundsNetwork(network)
    if (fundsNetwork === null) {
      setUnavailable(`no Midnight endpoint for ${network}`)
      return
    }
    setSyncing(true)
    setUnavailable(null)
    const outcome = await Effect.runPromise(
      Effect.either(
        syncUnshieldedWallet({groupId, accountIndex: selectedAccountIndex, address, network: fundsNetwork}),
      ),
    )
    setSyncing(false)
    if (Either.isLeft(outcome)) {
      // The balance keeps whatever the feed gave us; the failure is reported rather than shown as zero.
      // `cause` separates a build with no indexer for this network — which no retry fixes — from a
      // socket that failed, which is the distinction Q5 on the follow-ups board asks for.
      logger.warn('an unshielded refresh failed', {
        origin: ORIGIN,
        groupId,
        network: fundsNetwork,
        cause: outcome.left._tag === 'UnshieldedSyncError' ? outcome.left.cause : 'storage',
        error: outcome.left.reason,
      })
      setUnavailable(outcome.left.reason)
    }
  }, [address, groupId, network, selectedAccountIndex])

  return {
    totals,
    utxos: live?.spendable ?? null,
    utxoCount: live === undefined ? null : live.spendable.length,
    syncing,
    unavailable,
    refresh,
  }
}
