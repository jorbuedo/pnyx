/**
 * Send compose-queue state for the funnel: restore on mount, queue a built
 * send, discard a leg, drop legs that have been broadcast.
 *
 * Restoring is where the care is. A persisted queue's inputs may have been
 * spent while the app was closed, so `resumeQueue` re-validates and this hook
 * *tells the user* when legs were dropped — a silently shrinking queue would
 * leave the banner and the spendable balance disagreeing.
 *
 * @module
 */

import {type UtxoOverlayEntry, utxoId} from '@pnyx/wallet'
import {Effect} from 'effect'
import {useCallback, useEffect, useMemo, useRef, useState} from 'react'
import {useToast} from '../../../hooks/useToast'
import {logger} from '../../../logger'
import {useI18n} from '../../../providers'
import type {CardanoRail} from '../../../services/cardano'
import type {SendReview} from '../../../services/cardano/send-flow'
import {
  appendLeg,
  canQueue,
  discardLeg,
  legFromSendReview,
  queueOverlayEntries,
  resumeQueue,
  type SendQueueLeg,
  saveQueue,
} from '../../../services/cardano/send-queue'
import {createProfileStorage} from '../../../services/profile/profile-storage'

export type SendQueueApi = {
  readonly legs: readonly SendQueueLeg[]
  /** Overlay entries for the next build; empty when nothing is queued. */
  readonly overlayEntries: readonly UtxoOverlayEntry[]
  readonly canQueueMore: boolean
  /** Freeze a built send onto the queue. False when it was rejected. */
  readonly queue: (review: SendReview) => Promise<boolean>
  readonly discard: (legId: string) => Promise<void>
  /**
   * Drop the first `count` legs because they have been broadcast. Deliberately
   * does **not** cascade: a landed leg's change is a real UTxO now, so anything
   * chained onto it is still valid.
   */
  readonly dropLanded: (count: number) => Promise<void>
}

export const useSendQueue = (rail: CardanoRail | null, groupId: string | null): SendQueueApi => {
  const {t} = useI18n()
  const {showToast} = useToast()
  const [legs, setLegs] = useState<readonly SendQueueLeg[]>([])
  const [overlayEntries, setOverlayEntries] = useState<readonly UtxoOverlayEntry[]>([])
  const storage = useMemo(() => createProfileStorage(), [])
  // Queue writes must not race the restore that runs on mount.
  const restored = useRef(false)

  const refreshOverlay = useCallback(
    async (next: readonly SendQueueLeg[]) => {
      if (rail === null || next.length === 0) {
        setOverlayEntries([])
        return
      }
      const entries = await Effect.runPromise(
        queueOverlayEntries(rail, next).pipe(Effect.orElseSucceed(() => [] as readonly UtxoOverlayEntry[])),
      )
      setOverlayEntries(entries)
    },
    [rail],
  )

  useEffect(() => {
    let active = true
    if (rail === null || groupId === null) return
    void (async () => {
      try {
        // The rail's own view, *without* the queue overlay: a queued leg's inputs
        // are still unspent on chain, so this is what staleness is judged against.
        const available = new Set((await Effect.runPromise(rail.spendableUtxos)).map(utxoId))
        const outcome = await Effect.runPromise(resumeQueue(storage, groupId, available))
        if (!active) return
        if (outcome._tag === 'Corrupt') {
          showToast({variant: 'error', message: t('cardanoSend.queue.restoreFailed')})
          setLegs([])
          await refreshOverlay([])
        } else if (outcome._tag === 'Invalidated') {
          showToast({
            variant: 'error',
            message: t('cardanoSend.queue.dropped', {count: outcome.droppedLegIds.length}),
          })
          setLegs(outcome.legs)
          await refreshOverlay(outcome.legs)
        } else if (outcome._tag === 'Restored') {
          setLegs(outcome.legs)
          await refreshOverlay(outcome.legs)
        } else {
          setLegs([])
          await refreshOverlay([])
        }
      } catch (error) {
        logger.warn('send queue restore failed', {origin: 'useSendQueue', error: String(error)})
      } finally {
        restored.current = true
      }
    })()
    return () => {
      active = false
    }
  }, [rail, groupId, storage, refreshOverlay, showToast, t])

  const queue = useCallback(
    async (review: SendReview): Promise<boolean> => {
      if (groupId === null || !restored.current) return false
      const leg = legFromSendReview(review, `${review.txHash}`, Date.now())
      const result = appendLeg(legs, leg)
      if (result._tag === 'QueueFull') {
        showToast({variant: 'error', message: t('cardanoSend.queue.full', {max: result.max})})
        return false
      }
      if (result._tag === 'DuplicateLeg') {
        showToast({variant: 'error', message: t('cardanoSend.queue.duplicate')})
        return false
      }
      await Effect.runPromise(saveQueue(storage, groupId, result.queue))
      setLegs(result.queue)
      await refreshOverlay(result.queue)
      return true
    },
    [groupId, legs, storage, refreshOverlay, showToast, t],
  )

  const discard = useCallback(
    async (legId: string) => {
      if (groupId === null) return
      const {removedLegIds, kept} = discardLeg(legs, legId)
      await Effect.runPromise(saveQueue(storage, groupId, kept))
      setLegs(kept)
      await refreshOverlay(kept)
      if (removedLegIds.length > 1) {
        showToast({
          variant: 'info',
          message: t('cardanoSend.queue.discardedDependents', {count: removedLegIds.length - 1}),
        })
      }
    },
    [groupId, legs, storage, refreshOverlay, showToast, t],
  )

  const dropLanded = useCallback(
    async (count: number) => {
      if (groupId === null || count <= 0) return
      const kept = legs.slice(count)
      await Effect.runPromise(saveQueue(storage, groupId, kept))
      setLegs(kept)
      await refreshOverlay(kept)
    },
    [groupId, legs, storage, refreshOverlay],
  )

  return {legs, overlayEntries, canQueueMore: canQueue(legs), queue, discard, dropLanded}
}
