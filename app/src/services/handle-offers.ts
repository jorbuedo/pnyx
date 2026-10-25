/**
 * Reading what a name costs from the payment contract's own state.
 *
 * The storefront's only question, and it has to be asked of the chain rather than answered from a
 * constant: `prices` is mutable state behind `setPrice`, so which tiers are obtainable is a decision
 * the namespace's operator makes after this build shipped. A hardcoded table would keep offering a
 * tier that had been closed, and keep refusing one that had been opened.
 *
 * ⚠️ **A tier is priced *per currency*, and a currency cannot be enumerated.** `prices` is keyed by
 * `H(domain ‖ permitDomain(tier) ‖ colour)`, so the contract cannot be asked what it accepts — only
 * whether it accepts a colour the asker already knows. This build knows two: the reserved free colour,
 * and NIGHT. A tier priced in anything else reads as closed, which is honest about what this build can
 * do rather than about what the contract allows.
 *
 * The decision rule is next door in `handle-offer-rule.ts`, which is pure and imports no native module.
 *
 * @module
 */

import {NIGHT_COLOUR, paymentTierOffers} from '@pnyx/midnight-native'
import {midnightPaymentAddress} from '../config/env'
import {logger} from '../logger'
import type {TierRead} from './handle-offer-rule'
import {readPnyxContractState} from './pnyx-contract-state'

const ORIGIN = 'handle-offers'

/**
 * Every tier the payment contract currently sells.
 *
 * Never throws: each way this can fail is a state the storefront has to render, so they come back as
 * values. Each is logged — a screen that says "handles are unavailable" for three different reasons is
 * undiagnosable otherwise.
 */
export const readTierOffers = async (): Promise<TierRead> => {
  const address = midnightPaymentAddress()
  if (address === undefined) {
    logger.debug('no payment contract configured, so there is no namespace to price', {origin: ORIGIN})
    return {kind: 'no-namespace'}
  }
  let state: Uint8Array | null
  try {
    state = await readPnyxContractState(address)
  } catch (error) {
    logger.warn('payment contract state read threw', {origin: ORIGIN, address, error: String(error)})
    return {kind: 'unreadable', detail: 'the payment contract could not be read'}
  }
  if (state === null) {
    // `readPnyxContractState` returns null for "could not look" as well as "nothing deployed", and both
    // are worth a line: a wrong address and an indexer outage are the two ways this fails.
    logger.warn('payment contract state is unavailable', {origin: ORIGIN, address})
    return {kind: 'unreadable', detail: 'the payment contract could not be read'}
  }
  try {
    const offers = await paymentTierOffers(state, NIGHT_COLOUR)
    logger.debug('payment tiers read', {
      origin: ORIGIN,
      free: offers.filter((o) => o.free).map((o) => o.tier),
      priced: offers.filter((o) => o.price !== null).map((o) => o.tier),
    })
    return {kind: 'offers', offers}
  } catch (error) {
    logger.warn('payment tier offers could not be decoded', {origin: ORIGIN, error: String(error)})
    return {kind: 'unreadable', detail: 'the payment contract’s prices could not be decoded'}
  }
}
