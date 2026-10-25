/**
 * Convert between an absolute slot (a TTL, a validity-interval bound) and
 * wall-clock time on the active network.
 *
 * Both directions return `null` for anything they cannot place — while the
 * anchor is unresolved, when there is no rail, or when the value falls outside
 * the anchor's era. Callers fall back to the raw slot number rather than waiting
 * or guessing.
 *
 * Resolution is normally a storage read, not a request: see
 * `services/cardano/slot-anchor.ts` for why the stored pair is preferred.
 *
 * @module
 */

import {Effect} from 'effect'
import {useCallback, useEffect, useState} from 'react'
import {logger} from '../logger'
import type {CardanoNetwork} from '../services/cardano/config'
import {resolveCardanoSlotAnchor} from '../services/cardano/slot-anchor'
import {dateToSlot, ERA_START_SLOT, type SlotAnchor, slotToDate} from '../services/cardano/slot-time'
import {useCardanoRail} from './useCardanoRail'

const useSlotAnchor = (): {anchor: SlotAnchor | null; network: CardanoNetwork | null} => {
  const {rail} = useCardanoRail()
  const [anchor, setAnchor] = useState<SlotAnchor | null>(null)
  const network = rail?.config.network ?? null

  useEffect(() => {
    if (rail === null) return
    let active = true
    void Effect.runPromise(resolveCardanoSlotAnchor(rail))
      .then((a) => {
        if (active) setAnchor(a)
      })
      .catch((e) => {
        logger.warn('Slot anchor unavailable; slots render without dates', {
          origin: 'useSlotDate',
          error: String(e),
        })
      })
    return () => {
      active = false
    }
  }, [rail])

  return {anchor, network}
}

export const useSlotDate = (): ((slot: number | bigint) => Date | null) => {
  const {anchor, network} = useSlotAnchor()

  return useCallback(
    (slot: number | bigint) => (network === null ? null : slotToDate(network, anchor, slot)),
    [network, anchor],
  )
}

/**
 * Both directions, plus `ready` and the earliest date either can express.
 *
 * `ready` tells a screen whether it can offer a date at all: a field that asks
 * for a date it cannot convert would be lying about what goes into the
 * transaction, so the caller falls back to the raw slot number.
 *
 * `earliest` is the network's era boundary as a date — the floor below which the
 * conversion refuses — and belongs on a picker as its minimum.
 */
export const useSlotClock = (): {
  readonly ready: boolean
  readonly earliest: Date | null
  readonly toDate: (slot: number | bigint) => Date | null
  readonly toSlot: (date: Date) => number | null
} => {
  const {anchor, network} = useSlotAnchor()

  const toDate = useCallback(
    (slot: number | bigint) => (network === null ? null : slotToDate(network, anchor, slot)),
    [network, anchor],
  )
  const toSlot = useCallback(
    (date: Date) => (network === null ? null : dateToSlot(network, anchor, date)),
    [network, anchor],
  )

  return {
    ready: anchor !== null && network !== null,
    earliest: network === null ? null : slotToDate(network, anchor, ERA_START_SLOT[network]),
    toDate,
    toSlot,
  }
}
