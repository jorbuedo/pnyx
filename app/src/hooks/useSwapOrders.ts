/**
 * The wallet's swap orders, across BOTH SteelSwap order books.
 *
 * The AMM aggregator and the ATC limit book are separate stores — an order in
 * one never appears in the other — so this fetches both and merges them through
 * `order-model.ts`. They also fail independently: the AMM rail needs a
 * credential and the ATC rail needs a staking address, so one can answer while
 * the other cannot. Each failure is reported on its own rather than collapsing
 * the whole list to "could not load", because a wallet with working market
 * orders should still see them when only the limit rail is unavailable.
 *
 * @module
 */

import {Effect} from 'effect'
import {useCallback, useEffect, useState} from 'react'
import {logger} from '../logger'
import {fetchAtcOrders} from '../services/cardano-swap/atc-client'
import {fetchOrders} from '../services/cardano-swap/client'
import {
  mergeOrders,
  type NormalizedOrder,
  normalizeAmmOrder,
  normalizeAtcOrder,
} from '../services/cardano-swap/order-model'
import {useCardanoRail} from './useCardanoRail'

export type SwapOrdersState = {
  readonly orders: readonly NormalizedOrder[]
  readonly loading: boolean
  /** The market rail failed. Limit orders (if any) are still listed. */
  readonly ammError: string | null
  /**
   * The limit rail failed, or this wallet has no staking credential and so
   * cannot own ATC orders at all (`noStakeAddress`).
   */
  readonly limitError: 'noStakeAddress' | 'failed' | null
  readonly reload: () => void
}

export const useSwapOrders = (): SwapOrdersState => {
  const {rail} = useCardanoRail()
  const [orders, setOrders] = useState<readonly NormalizedOrder[]>([])
  /**
   * Starts true: there is always a fetch on mount, and a first render that says
   * `loading: false` with no orders paints "No orders yet" for a beat before the
   * real list arrives — an empty state that is simply wrong.
   */
  const [loading, setLoading] = useState(true)
  const [ammError, setAmmError] = useState<string | null>(null)
  const [limitError, setLimitError] = useState<'noStakeAddress' | 'failed' | null>(null)
  const [nonce, setNonce] = useState(0)

  const reload = useCallback(() => setNonce((n) => n + 1), [])

  const addressBech32 = rail?.account.addressBech32 ?? null
  const stakeBech32 = rail?.account.rewardAddressBech32 ?? null

  // biome-ignore lint/correctness/useExhaustiveDependencies: `nonce` is the reload trigger — it is meant to re-run this, not to be read.
  useEffect(() => {
    if (addressBech32 === null) {
      // No wallet to ask about — that is a resolved state, not a pending one.
      setLoading(false)
      return
    }
    let active = true
    setLoading(true)
    const now = Date.now()

    const ammP = Effect.runPromise(
      Effect.either(fetchOrders({addresses: [addressBech32], limit: 50, expand: ['legs']}, now)),
    )
    // ATC ownership is the STAKING credential — an enterprise address is a 400,
    // so it is not even attempted rather than firing a request that must fail.
    const limitP =
      stakeBech32 === null
        ? Promise.resolve(null)
        : Effect.runPromise(Effect.either(fetchAtcOrders({owner: stakeBech32, limit: 100})))

    void Promise.all([ammP, limitP]).then(([ammRes, limitRes]) => {
      if (!active) return
      const amm = ammRes._tag === 'Right' ? ammRes.right.items.map(normalizeAmmOrder) : []
      if (ammRes._tag === 'Left') {
        logger.warn('Could not load market swap orders', {origin: 'useSwapOrders', error: ammRes.left.reason})
        setAmmError(ammRes.left.reason)
      } else {
        setAmmError(null)
      }

      let limit: readonly NormalizedOrder[] = []
      if (limitRes === null) {
        setLimitError('noStakeAddress')
      } else if (limitRes._tag === 'Left') {
        logger.warn('Could not load limit orders', {origin: 'useSwapOrders', error: limitRes.left.reason})
        setLimitError('failed')
      } else {
        limit = limitRes.right.map((o) => normalizeAtcOrder(o))
        setLimitError(null)
      }

      setOrders(mergeOrders(amm, limit))
      setLoading(false)
    })

    return () => {
      active = false
    }
  }, [addressBech32, stakeBech32, nonce])

  return {orders, loading, ammError, limitError, reload}
}
