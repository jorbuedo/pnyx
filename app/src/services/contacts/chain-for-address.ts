/**
 * Which chain a contact's address belongs to — read from the address, not asked.
 *
 * A contact used to be stored under a hardcoded `CARDANO_MAINNET` at both save sites, which made the
 * `chain` field and the chain icon beside every row decoration: they could only ever say one thing.
 * Detection uses `routeRecipient`, the same classifier the send funnel picks its rail with, so a
 * contact and a pasted address can never disagree about what an address is.
 *
 * **Network is deliberately not bound**, matching the existing Cardano rule: a contact may hold an
 * address for any network, and the send flow binds the network at send time. So a Midnight address
 * is stored under `MIDNIGHT_MAINNET` whichever network it names — the field records *which chain*,
 * and the picker filters by namespace for exactly that reason.
 *
 * @module
 */

import {CARDANO_MAINNET, type ChainId, MIDNIGHT_MAINNET} from '@pnyx/config'
import {Effect} from 'effect'

import {routeRecipient} from '../send/recipient-rail'
import {validateContactAddress} from './validation'

export type ContactChainResolution =
  | {readonly ok: true; readonly chain: ChainId}
  | {readonly ok: false; readonly reason: 'empty' | 'invalid-address' | 'dust-address'}

/**
 * Resolve the chain to store a contact's address under, validating it on the way.
 *
 * A DUST address gets its own refusal: it is a perfectly good Midnight address that can never be
 * paid, so "invalid address" would send someone hunting for a typo that is not there.
 */
export const resolveContactChain = (
  addressBech32: string,
  appNetwork: string | null,
): Effect.Effect<ContactChainResolution> => {
  const trimmed = addressBech32.trim()
  if (trimmed.length === 0) return Effect.succeed({ok: false, reason: 'empty'})

  const route = routeRecipient(trimmed, appNetwork)
  if (route.rail === 'midnight') return Effect.succeed({ok: true, chain: MIDNIGHT_MAINNET})
  if (route.rail === 'unusable') {
    return Effect.succeed({
      ok: false,
      reason: route.reason === 'dust-address' ? 'dust-address' : 'invalid-address',
    })
  }
  return validateContactAddress(CARDANO_MAINNET, trimmed).pipe(
    Effect.map(
      (validation): ContactChainResolution =>
        validation.ok ? {ok: true, chain: CARDANO_MAINNET} : {ok: false, reason: validation.reason},
    ),
  )
}
