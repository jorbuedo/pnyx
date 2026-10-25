/**
 * Per-protocol batcher health, for the warning shown before a swap is placed.
 *
 * An order settles when a venue's batcher picks it up, so a batcher that is
 * behind means an order that sits. Warning first beats explaining afterwards.
 *
 * ⚠️ `GET /api/v2/batcher/status` is **public** — no credential — so this keeps
 * working when the pricing credential does not, and is deliberately not gated
 * behind the swap auth state.
 *
 * ⚠️ An absent `status` is missing data, never an error: a protocol that has not
 * been snapshotted yet (quiet, or a restart window) simply has none, and is not
 * reported as unhealthy.
 *
 * @module
 */

import {Effect} from 'effect'
import {useEffect, useState} from 'react'
import {logger} from '../logger'
import {fetchBatcherStatus} from '../services/cardano-swap/client'
import type {BatcherProtocol} from '../services/cardano-swap/types'

export type BatcherHealth = {
  /** Protocols reporting WARN or DOWN, worst first. `null` until a status is read. */
  readonly degraded: readonly BatcherProtocol[]
  readonly worst: 'WARN' | 'DOWN' | null
}

export const useBatcherHealth = (): BatcherHealth => {
  const [degraded, setDegraded] = useState<readonly BatcherProtocol[]>([])
  const [worst, setWorst] = useState<'WARN' | 'DOWN' | null>(null)

  useEffect(() => {
    let active = true
    void Effect.runPromise(Effect.either(fetchBatcherStatus(Date.now()))).then((res) => {
      if (!active) return
      if (res._tag === 'Left') {
        logger.debug('Batcher status unavailable; no health warning is shown', {
          origin: 'useBatcherHealth',
          error: res.left.reason,
        })
        return
      }
      const bad = res.right.filter((p) => p.status === 'WARN' || p.status === 'DOWN')
      const down = bad.filter((p) => p.status === 'DOWN')
      setDegraded([...down, ...bad.filter((p) => p.status === 'WARN')])
      setWorst(down.length > 0 ? 'DOWN' : bad.length > 0 ? 'WARN' : null)
    })
    return () => {
      active = false
    }
  }, [])

  return {degraded, worst}
}
