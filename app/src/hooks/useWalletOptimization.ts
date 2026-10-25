/**
 * The wallet-optimization policy as editable state, for the settings screen.
 *
 * Deliberately not a provider. Consumers that *act* on the policy — the
 * consolidate action, the send flow's auto-consolidate check — read it from
 * storage at the moment they need it (`loadWalletOptimization`), because a
 * screen that mounted before the user changed a setting would otherwise act on
 * the value it cached. This hook exists only for the surface that edits it.
 *
 * @module
 */

import {useCallback, useEffect, useState} from 'react'
import {
  DEFAULT_WALLET_OPTIMIZATION,
  loadWalletOptimization,
  saveWalletOptimization,
  type WalletOptimization,
} from '../services/cardano/consolidation'

export type WalletOptimizationState = {
  readonly policy: WalletOptimization
  /** True until the stored policy has been read, so the UI can avoid flicker. */
  readonly loading: boolean
  /** Update one knob. Resolves `false` when the write failed. */
  readonly setFlag: (
    key: 'autoConsolidate' | 'autoWithdrawRewards' | 'bundleByPolicy' | 'keepPureAdaOutput',
    value: boolean,
  ) => Promise<boolean>
  /**
   * Set or clear the per-transaction input cap. `null` clears it, and clears it by
   * *omitting* the key — a stored `undefined` is not JSON, and a stored `0` would
   * decode as corruption rather than as "no cap".
   */
  readonly setInputCap: (value: number | null) => Promise<boolean>
}

export const useWalletOptimization = (): WalletOptimizationState => {
  const [policy, setPolicy] = useState<WalletOptimization>(DEFAULT_WALLET_OPTIMIZATION)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    void loadWalletOptimization().then((stored) => {
      if (!active) return
      setPolicy(stored)
      setLoading(false)
    })
    return () => {
      active = false
    }
  }, [])

  const setFlag = useCallback(
    async (key: Parameters<WalletOptimizationState['setFlag']>[0], value: boolean): Promise<boolean> => {
      // Optimistic: the toggle reflects the choice immediately, and a failed
      // write is reported rather than silently reverting under the user's finger.
      const next = {...policy, [key]: value}
      setPolicy(next)
      return saveWalletOptimization(next)
    },
    [policy],
  )

  const setInputCap = useCallback(
    async (value: number | null): Promise<boolean> => {
      const {maxInputsPerTx: _cleared, ...rest} = policy
      const next: WalletOptimization = value === null ? rest : {...rest, maxInputsPerTx: value}
      setPolicy(next)
      return saveWalletOptimization(next)
    },
    [policy],
  )

  return {policy, loading, setFlag, setInputCap}
}
