/**
 * The chain's current block height, for turning a transaction's block height into
 * a confirmation count.
 *
 * This is the one fact on the review that is **not** a fact about the
 * transaction. Everything else there — slot, epoch, block hash, the phase-2
 * verdict — was fixed the moment the transaction landed and can be persisted,
 * cached and trusted indefinitely. A confirmation count is a statement about the
 * distance from here to now, so it is read live and never stored: a stale one is
 * simply wrong, and wrong in the direction that matters (it under-reports how
 * settled a transaction is).
 *
 * `null` while unresolved and whenever the provider cannot answer — the caller
 * renders nothing rather than a count it cannot stand behind.
 *
 * @module
 */

import {Effect} from 'effect'
import {useEffect, useState} from 'react'
import {logger} from '../logger'
import {chainTip} from '../services/cardano/chain-tip'
import {useCardanoRail} from './useCardanoRail'

export const useCardanoTipHeight = (): number | null => {
  const {rail} = useCardanoRail()
  const [height, setHeight] = useState<number | null>(null)

  useEffect(() => {
    if (rail === null) return
    let active = true
    void Effect.runPromise(
      chainTip(rail.chain).pipe(
        Effect.map((tip) => tip.blockHeight ?? null),
        Effect.catchAll((e) => {
          logger.warn('Chain tip unavailable; no confirmation height this round', {
            origin: 'useCardanoTipHeight',
            error: String(e),
          })
          return Effect.succeed(null)
        }),
      ),
    )
      .then((h) => {
        if (active) setHeight(h)
      })
      .catch((e) => {
        logger.warn('Tip-height read rejected', {origin: 'useCardanoTipHeight', error: String(e)})
      })
    return () => {
      active = false
    }
  }, [rail])

  return height
}
