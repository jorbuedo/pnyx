/**
 * The address a message signature asserts, in the spelling its owner can check.
 *
 * ⚠️ **Hex is not a form a person can compare.** A review screen's whole job is to let someone
 * answer "is that my wallet?", and the answer lives somewhere else — an explorer, Koios, another
 * wallet — all of which say `stake1u9mxvus9…`. Showing `e1766672…` beside "Signing with" is
 * accurate and unusable, which on a consent surface is the same as unshown.
 *
 * Falls back to the raw bytes rather than to nothing: a payload whose address will not decode is
 * still something the user is being asked to sign with, and hiding it would be worse than showing
 * it in a form they cannot read. The failure is logged, because "this did not decode" and "this is
 * what it says" must not render the same.
 *
 * @module
 */

import {AddressHex} from '@evolution-sdk/review/Brands'
import {Address} from '@pnyx/cardano-core'
import {Effect} from 'effect'
import {logger} from '../../../logger'

const ORIGIN = 'signing-address-display'

/**
 * `addressHex` as bech32 (`addr1…` / `stake1…`), or the hex unchanged when it does not decode.
 *
 * Synchronous: both codec layers are `Layer.succeed`, so `runSync` on the app runtime is safe and
 * this can be called straight from render.
 */
export const signingAddressDisplay = (addressHex: string): string => {
  try {
    return Effect.runSync(Address.toBech32(AddressHex(addressHex)))
  } catch (error) {
    logger.warn('the signing address did not decode, so it is shown as raw bytes', {
      origin: ORIGIN,
      error: String(error),
    })
    return addressHex
  }
}
