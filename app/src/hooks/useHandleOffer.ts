/**
 * What the name being typed would cost, and whether it is for sale at all.
 *
 * **Two reads with different shapes.** What each tier costs is a property of the contract that does not
 * change while somebody types, so it is read once per mount and {@link offerFor} is applied to every
 * character. Who holds *this* name is a different contract per name, so it has to be read per name —
 * debounced, because a keystroke is not a question worth a round trip.
 *
 * The second read is what makes a stuck claim finishable: a name this identity already holds needs no
 * permit and no open tier, only the row write that displays it.
 *
 * @module
 */

import {canonicalizeHandle, validateHandle} from '@pnyx/contract-client/handle'
import {decodePnyxId} from '@pnyx/contract-client/identity'
import {useEffect, useMemo, useState} from 'react'
import {logger} from '../logger'
import {usePnyxSession} from '../providers'
import {type HandleOffer, type NameHeld, offerFor} from '../services/handle-offer-rule'
import {readNameOwnership} from '../services/handle-resolve'
import {useTierOffers} from './useTierOffers'

const ORIGIN = 'useHandleOffer'

/** Long enough that a typed name is not a read per character, short enough not to feel like a wait. */
const OWNER_READ_DEBOUNCE_MS = 500

/** `undefined` while the read is in flight — distinct from every settled answer. */
export const useHandleOffer = (name: string): HandleOffer | undefined => {
  const {identity} = usePnyxSession()
  // Shared with the lengths table on the claim screen — see {@link useTierOffers}.
  const read = useTierOffers()
  const [held, setHeld] = useState<NameHeld>('unknown')

  // The canonical name, so `Alice` and `alice` are one read rather than two: the address a handle
  // deploys to derives from the folded form.
  const checked = validateHandle(name)
  const canonical = checked.ok ? canonicalizeHandle(checked.handle) : undefined
  const pnyxId = identity?.pnyxId

  useEffect(() => {
    // Back to `unknown` on every change, so a verdict about the previous name is never shown beside
    // this one. It is the value that falls through to the price list, which is the safe default.
    setHeld('unknown')
    if (canonical === undefined || pnyxId === undefined) return
    let live = true
    const timer = setTimeout(() => {
      void readNameOwnership(canonical, decodePnyxId(pnyxId).identity)
        .then((owner) => {
          if (live) setHeld(owner)
        })
        // `readNameOwnership` answers `'unknown'` for every failure it knows about, so a rejection is a
        // defect — logged rather than swallowed, and left as `'unknown'`, which offers rather than blocks.
        .catch((error: unknown) => {
          logger.warn('the name-owner read rejected unexpectedly', {origin: ORIGIN, error: String(error)})
        })
    }, OWNER_READ_DEBOUNCE_MS)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [canonical, pnyxId])

  return useMemo(() => (read === undefined ? undefined : offerFor(name, read, held)), [name, read, held])
}
