/**
 * Whether this wallet has NIGHT a registration could actually do anything with.
 *
 * Reads the **cached** unshielded set rather than syncing. The question is only "is this button worth
 * offering", and a network round trip to answer it would make opening the screen slower for everyone
 * to spare a minority one tap.
 *
 * ## Why the button needs gating at all
 *
 * On preprod the faucet registers the NIGHT it sends, so a faucet-funded wallet arrives already
 * generating and there is nothing left to register — the button can only ever refuse. Registration is
 * once per key besides: the ledger grants generation info to any NIGHT arriving at an owner that has a
 * delegation, so a registered wallet never needs it again.
 *
 * ## Absence is not "nothing to do"
 *
 * Three states, not two. `undefined` while the cache is being read, and again when the cache belongs to
 * a different address than the one on screen — a set is only meaningful for the address that owns it,
 * and a network switch leaves exactly that mismatch. The button is offered whenever the answer is
 * unknown, because hiding a working action on a failed read is the worse mistake: the action itself
 * refuses accurately, so the cost of offering it wrongly is one tap.
 *
 * @module
 */

import {useEffect, useState} from 'react'

import {logger} from '../../../logger'
import {runMidnight} from '../../../services/midnight/effect-boundary'
import {registrationInputs} from '../../../services/midnight/registration-inputs'
import {loadUnshieldedCache} from '../../../services/midnight/wallet/unshielded-store'

const ORIGIN = 'use-registrable-night'

/**
 * `true` / `false` once known, `undefined` while unknown.
 *
 * Callers must treat `undefined` as "offer it" — see the module note.
 */
export const useRegistrableNight = (
  groupId: string | undefined,
  accountIndex: number,
  address: string | undefined,
): boolean | undefined => {
  const [has, setHas] = useState<boolean | undefined>(undefined)

  useEffect(() => {
    if (groupId === undefined || address === undefined) {
      setHas(undefined)
      return
    }
    let active = true
    runMidnight(loadUnshieldedCache(groupId, accountIndex))
      .then((cache) => {
        if (!active) return
        if (cache === undefined) {
          logger.debug('no cached unshielded set yet; offering the register button', {origin: ORIGIN, groupId})
          setHas(undefined)
          return
        }
        if (cache.address !== address) {
          logger.debug('the cached unshielded set is for another address; offering the register button', {
            origin: ORIGIN,
            groupId,
          })
          setHas(undefined)
          return
        }
        const registrable = registrationInputs([...cache.utxos.values()])
        logger.debug('read whether this wallet has NIGHT left to register', {
          origin: ORIGIN,
          groupId,
          cached: cache.utxos.size,
          registrable: registrable.length,
        })
        setHas(registrable.length > 0)
      })
      .catch((error: unknown) => {
        if (!active) return
        // Never silent, and never `false`: a read that failed is not a wallet with nothing to register,
        // and collapsing the two would hide the button for a reason nobody could diagnose.
        logger.warn('could not read the cached unshielded set; offering the register button anyway', {
          origin: ORIGIN,
          groupId,
          error: String(error),
        })
        setHas(undefined)
      })
    return () => {
      active = false
    }
  }, [groupId, accountIndex, address])

  return has
}
