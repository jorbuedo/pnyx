/**
 * Full activity for a single token, read from the LOCAL tx store (populated by
 * the history sync worker) — every past tx is persisted, so there's no paging
 * or network: load them all once and keep the ones whose own-delta moves this
 * token. ADA (`includeAll`) keeps the whole history (every tx moves ADA for
 * fees). Reviewed rows are primed into the shared cache so tapping through to
 * the tx-detail screen resolves by hash.
 *
 * @module
 */

import type {ReviewedTransaction} from '@pnyx/tx-review'
import {Effect} from 'effect'
import {useEffect, useState} from 'react'
import {logger} from '../logger'
import {loadCardanoHistory} from '../services/cardano'
import {primeHistoryCache} from './useCardanoHistory'
import {useCardanoRail} from './useCardanoRail'

export type CardanoTokenHistory = {
  readonly txs: readonly ReviewedTransaction[]
  readonly loading: boolean
}

const touchesAsset = (tx: ReviewedTransaction, assetId: string): boolean =>
  tx.ownDelta.some((d) => d.assetId === assetId)

export const useCardanoTokenHistory = (assetId: string, includeAll: boolean): CardanoTokenHistory => {
  const {rail} = useCardanoRail()
  const [txs, setTxs] = useState<readonly ReviewedTransaction[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (rail === null) {
      setLoading(false)
      return
    }
    let active = true
    setLoading(true)
    // No `limit` → the whole persisted history; all local, no network.
    void Effect.runPromise(
      loadCardanoHistory(rail, {}).pipe(
        Effect.catchAll((e) => {
          logger.warn('History read failed; the token has no activity to show', {
            origin: 'useCardanoTokenHistory',
            error: String(e),
          })
          return Effect.succeed([] as readonly ReviewedTransaction[])
        }),
      ),
    ).then((rows) => {
      if (!active) return
      primeHistoryCache(rows)
      setTxs(includeAll ? rows : rows.filter((tx) => touchesAsset(tx, assetId)))
      setLoading(false)
    })
    return () => {
      active = false
    }
  }, [rail, assetId, includeAll])

  return {txs, loading}
}
