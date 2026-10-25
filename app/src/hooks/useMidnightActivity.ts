/**
 * The selected funds group's unshielded Midnight transactions, newest first.
 *
 * Read from the **live feed**, not from a cache plus a re-read. The subscription that yields the UTxO
 * set carries the transactions that produced it, so this costs no extra network work — and because the
 * feed stays open, a transaction that lands while this list is on screen appears without anything
 * having to notice and tell it.
 *
 * ⚠️ **Unshielded only.** Shielded transfers have no by-address history to read (a coin has no address),
 * so they are absent rather than shown as an empty list. See `midnight-activity`.
 *
 * @module
 */

import {useCallback, useEffect, useState} from 'react'

import {logger} from '../logger'
import {useWalletList} from '../providers'
import type {MidnightActivity} from '../services/midnight/wallet/midnight-activity'
import {visiblePendingSends} from '../services/midnight/wallet/pending-send'
import {loadPendingSends, onPendingSendsChange} from '../services/midnight/wallet/pending-send-store'
import {useMidnightUnshieldedAddress} from './useMidnightUnshieldedAddress'
import {useUnshieldedFeed} from './useUnshieldedFeed'

const ORIGIN = 'midnight-activity'

export type MidnightActivityState = {
  /** `null` while unknown — nothing read for this address yet. An empty array means read, and none. */
  readonly items: readonly MidnightActivity[] | null
  readonly address: string | undefined
  readonly reload: () => void
}

export const useMidnightActivity = (): MidnightActivityState => {
  const {selectedWalletGroup, selectedAccountIndex} = useWalletList()
  const groupId = selectedWalletGroup?.groupId
  const address = useMidnightUnshieldedAddress()
  const {live} = useUnshieldedFeed(address)
  const [pending, setPending] = useState<readonly MidnightActivity[]>([])

  /**
   * Sends handed over but not yet on chain.
   *
   * Still read rather than derived: a submitted send exists only in the pending store until the feed
   * sees it land, so it has no row to project from. The stored row wins by containment the moment it
   * exists, so a row never duplicates — see `visiblePendingSends`.
   */
  const readPending = useCallback(async () => {
    if (groupId === undefined) {
      setPending([])
      return
    }
    try {
      const rows = await loadPendingSends(groupId, selectedAccountIndex)
      setPending(rows.length === 0 ? [] : visiblePendingSends(rows, live?.activity ?? [], Date.now()))
    } catch (error) {
      logger.warn('the pending Midnight sends could not be read', {origin: ORIGIN, groupId, error: String(error)})
      setPending([])
    }
  }, [groupId, live?.activity, selectedAccountIndex])

  useEffect(() => {
    void readPending()
  }, [readPending])

  // A send submitted while this list is already mounted must appear without waiting for a dep to change.
  // The *landed* half no longer needs a subscription of its own: the feed publishes it and
  // `useUnshieldedFeed` re-renders, which is what the `midnight-unshielded` store-change listener here
  // used to do by making this hook re-read the whole blob.
  useEffect(() => onPendingSendsChange(() => void readPending()), [readPending])

  // Nothing read yet. Showing a pending row over an unknown history would put a send above a list that
  // may already contain it, so wait for the feed rather than guess.
  const items = live === undefined ? null : [...pending, ...live.activity]

  return {items, address, reload: () => void readPending()}
}
