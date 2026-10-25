/**
 * Tradeable-token universe for the swap "to" picker. Backed by the shared,
 * persisted verified-token registry (`getVerifiedTokens`) so it paints instantly
 * from cache on cold start and is fetched at most once per session (shared with
 * the portfolio's verified filter). Order is preserved (popular first).
 *
 * @module
 */

import {useEffect, useState} from 'react'
import {logger} from '../logger'
import {getVerifiedTokens, readVerifiedTokensSync} from '../services/cardano-assets/verified-tokens'
import type {TradeableToken} from '../services/cardano-swap/token-universe'

export type TradeableTokensState = {
  readonly tokens: readonly TradeableToken[]
  readonly loading: boolean
}

export const useTradeableTokens = (): TradeableTokensState => {
  const [tokens, setTokens] = useState<readonly TradeableToken[]>(() => readVerifiedTokensSync()?.tokens ?? [])
  const [loading, setLoading] = useState(tokens.length === 0)

  useEffect(() => {
    let active = true
    void getVerifiedTokens(Date.now())
      .then((v) => {
        if (!active) return
        setTokens(v.tokens)
        setLoading(false)
      })
      .catch((error: unknown) => {
        // Was an unhandled rejection, and `setLoading(false)` only ran on the success path — so a
        // failed read spun for ever. Clearing it reports "no tradeable tokens", which is wrong but
        // honest about having finished; the reason is on record either way.
        if (!active) return
        logger.warn('the tradeable-token registry could not be read', {
          origin: 'tradeable-tokens',
          error: String(error),
        })
        setLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  return {tokens, loading}
}
