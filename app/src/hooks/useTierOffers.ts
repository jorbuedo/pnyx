/**
 * What every name length currently costs, read once from the payment contract.
 *
 * Its own hook because two surfaces need the same answer — the name field, which applies
 * {@link offerFor} to it per keystroke, and the lengths table, which renders it directly. Fetching it
 * in each would put two indexer reads on one screen for a value that does not change while somebody
 * types.
 *
 * @module
 */

import {useEffect, useState} from 'react'
import {logger} from '../logger'
import type {TierRead} from '../services/handle-offer-rule'
import {readTierOffers} from '../services/handle-offers'

const ORIGIN = 'useTierOffers'

/** `undefined` while the read is in flight — distinct from every settled answer, including failure. */
export const useTierOffers = (): TierRead | undefined => {
  const [read, setRead] = useState<TierRead | undefined>(undefined)

  useEffect(() => {
    let live = true
    void readTierOffers()
      .then((result) => {
        if (live) setRead(result)
      })
      // `readTierOffers` answers with a value for every failure it knows about, so a rejection here is
      // a defect rather than an outage — and it would otherwise leave the caller loading for ever.
      .catch((error: unknown) => {
        logger.warn('the tier read rejected unexpectedly', {origin: ORIGIN, error: String(error)})
        if (live) setRead({kind: 'unreadable', detail: 'the price list could not be read'})
      })
    return () => {
      live = false
    }
  }, [])

  return read
}
