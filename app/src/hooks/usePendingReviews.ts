/**
 * Read the two persisted "resumable work" stores and merge them into one newest-first
 * inbox list via the pure {@link aggregatePending}. Re-reads on screen focus so the badge
 * and inbox stay in sync after a resume / dismiss elsewhere.
 *
 * **Co-sign envelopes are listed for every wallet, continuations only for this one**, and
 * the asymmetry is the point. A continuation is one wallet's half-finished flow. A co-signed
 * transaction belongs to *several* wallets by construction, and it is filed under exactly
 * one of them — the composer's — so filtering by the selected group hid it from every other
 * party. On a device holding two of them that produced a dead end: the co-sign screen said
 * "switch to ‹wallet›", and the wallet you switched to had no route to the transaction,
 * because its group was never the one the envelope was filed under.
 *
 * Which wallet a row is *waiting on* is therefore derived from the roster rather than read
 * off the stored group — see {@link useLocalMultipartySigners} and `awaitingHere` below.
 *
 * @module
 */

import {Effect} from 'effect'
import {useFocusEffect} from 'expo-router'
import {useCallback, useState} from 'react'
import {logger} from '../logger'
import {platformContinuationStore} from '../services/cardano/continuation'
import {platformCosignRegistry} from '../services/cardano/cosign'
import {aggregatePending, type PendingReviewItem} from '../services/cardano/pending'
import {isSendQueueRecord} from '../services/cardano/send-queue'

const ORIGIN = 'pending-reviews'

export type PendingReviewsState = {
  readonly items: readonly PendingReviewItem[]
  readonly count: number
  readonly loading: boolean
  readonly refresh: () => void
}

export const usePendingReviews = (groupId: string | null): PendingReviewsState => {
  const [items, setItems] = useState<readonly PendingReviewItem[]>([])
  const [loading, setLoading] = useState(groupId !== null)

  const load = useCallback(async () => {
    if (groupId === null) {
      setItems([])
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const [cosigns, continuations] = await Promise.all([
        // No group: a co-signed transaction is not one wallet's.
        Effect.runPromise(platformCosignRegistry().list()),
        Effect.runPromise(platformContinuationStore().list(groupId)),
      ])
      // A Send compose queue is stored as a continuation but is pre-consent: it
      // has no `requests` to resume, so a row here would offer a Resume that
      // cannot work. Its surface is the Send funnel's queued-legs banner.
      setItems(
        aggregatePending(
          cosigns,
          continuations.filter((record) => !isSendQueueRecord(record)),
        ),
      )
    } catch (error) {
      // ⚠️ Still renders as an empty list, which is not the same fact — but now the reason is on
      // record. Telling "nothing to review" from "we could not read it" needs a state this hook does
      // not have; that is a UI change, not a logging one.
      logger.warn('the pending-review list could not be read; showing it as empty', {
        origin: ORIGIN,
        groupId,
        error: String(error),
      })
      setItems([])
    } finally {
      setLoading(false)
    }
  }, [groupId])

  const refresh = useCallback(() => {
    void load()
  }, [load])

  useFocusEffect(
    useCallback(() => {
      void load()
    }, [load]),
  )

  return {items, count: items.length, loading, refresh}
}
