/**
 * The selected funds group's shielded Midnight balance, read from persisted state.
 *
 * **No vault and no network.** A balance is a fact about the stored state blob, so it renders while the
 * wallet is locked and while offline; only *discovering* a coin needs the role key (it decrypts
 * ciphertexts) and only spending needs it to prove. That split is why this hook exists separately from
 * whatever performs a sync.
 *
 * ⚠️ **Absent state is not a zero balance.** A wallet that has never synced knows nothing about its coins,
 * and rendering `0` there would state as fact something we have not checked. `balances` is `null` until a
 * state exists; an empty array means we have one and it holds nothing.
 *
 * @module
 */

import {type WalletSummary, walletSummary} from '@pnyx/midnight-native'
import {useCallback, useEffect, useState} from 'react'
import {logger} from '../logger'
import {useConfig, useWalletList} from '../providers'
import {runMidnight} from '../services/midnight/effect-boundary'
import {midnightFundsNetwork} from '../services/midnight/networks'
import {loadShieldedState} from '../services/midnight/wallet/state-store'
import {onStoreChange} from '../services/store-change'

const ORIGIN = 'midnight-shielded-balance'

export type ShieldedBalanceState = {
  /** `null` while unknown — no state stored yet, or a read that failed. Never conflated with empty. */
  readonly balances: WalletSummary['balances'] | null
  /**
   * Every spendable coin, for a surface that lists them rather than totalling them. `null` under the
   * same rule as `balances`: unknown is not empty.
   */
  readonly coins: WalletSummary['coins'] | null
  /** Coins spent by a transfer awaiting confirmation. They are excluded from `balances`. */
  readonly pending: number
  readonly loading: boolean
  /** Re-read the stored state — cheap, and what a screen calls after a sync or a send. */
  readonly refresh: () => void
}

export const useMidnightShieldedBalance = (): ShieldedBalanceState => {
  const {selectedWalletGroup, selectedAccountIndex} = useWalletList()
  const {network} = useConfig()
  const fundsNetwork = midnightFundsNetwork(network)
  const groupId = selectedWalletGroup?.groupId ?? null
  const [state, setState] = useState<{
    balances: WalletSummary['balances'] | null
    coins: WalletSummary['coins'] | null
    pending: number
    loading: boolean
  }>({balances: null, coins: null, pending: 0, loading: groupId !== null})

  const read = useCallback(async () => {
    if (groupId === null || fundsNetwork === null) {
      setState({balances: null, coins: null, pending: 0, loading: false})
      return
    }
    try {
      const stored = await runMidnight(loadShieldedState(groupId, selectedAccountIndex, fundsNetwork))
      if (stored === undefined) {
        // Never synced: unknown, not zero.
        setState({balances: null, coins: null, pending: 0, loading: false})
        return
      }
      const summary = await walletSummary(stored)
      setState({balances: summary.balances, coins: summary.coins, pending: summary.pending, loading: false})
    } catch (error) {
      // A refusal to decode is deliberate in the store — it protects coins that exist nowhere else — so
      // surface it as unknown rather than as an empty wallet.
      logger.warn('shielded balance unavailable', {origin: ORIGIN, groupId, error: String(error)})
      setState({balances: null, coins: null, pending: 0, loading: false})
    }
  }, [groupId, selectedAccountIndex, fundsNetwork])

  useEffect(() => {
    void read()
    // `useMidnightSync` writes the state from outside this hook, so without this a balance on screen
    // stays on the pre-sync figure until the screen remounts.
    return onStoreChange('midnight-shielded', () => {
      void read()
    })
  }, [read])

  return {...state, refresh: () => void read()}
}
