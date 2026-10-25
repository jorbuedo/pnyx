/**
 * The credentials a Cardano address is built from, read out of the address itself.
 *
 * A Shelley address is a header nibble plus one or two 28-byte credentials, so
 * "which payment credential is this, and is it a script?" is byte slicing — no
 * keys, no derivation, no network. That matters in two places:
 *
 *  - a row can record what an address *is* without the wallet having derived it,
 *    which is the only way a script or watch-only address can carry a meaningful
 *    payment credential at all;
 *  - the rail already recomputes exactly this from bech32 to build its owned-
 *    credential set, so this is the one implementation of a thing done twice.
 *
 * ⚠️ **A credential is not ownership.** This says how an address is constructed.
 * Whether we can spend it is a lookup against what we hold, which is
 * `custodyOfAddress` in `custody.ts` — see `docs/CARDANO_CUSTODY_MODEL.md`.
 *
 * @module
 */

import {Address} from '@pnyx/cardano-core'
import {bech32} from '@pnyx/crypto'
import {logger} from '../../logger'

/** One half of an address: the 28-byte credential, and whether it is a script. */
export type AddressCredential = {
  readonly hex: string
  readonly isScript: boolean
}

export type AddressCredentials = {
  readonly payment: AddressCredential
  /** Absent on enterprise addresses, which carry no stake half at all. */
  readonly stake: AddressCredential | null
}

/**
 * Decompose a bech32 Cardano address, or `null` when it is not one this can read
 * (Byron, a reward address, malformed bech32).
 *
 * `null` rather than a guessed credential on purpose: a wrong credential silently
 * misattributes an address, and every caller here can say "unknown" instead.
 */
export const addressCredentials = (bech32Address: string): AddressCredentials | null => {
  const trimmed = bech32Address.trim()
  const decoded = decodeAddressHex(trimmed)
  if (decoded === null) return null
  const info = Address.inspect(decoded)
  if (info.paymentCredHex === undefined) return null
  return {
    payment: {hex: info.paymentCredHex, isScript: info.paymentIsScript === true},
    stake: info.stakeCredHex === undefined ? null : {hex: info.stakeCredHex, isScript: info.stakeIsScript === true},
  }
}

/** The payment credential alone — what an address row records. */
export const paymentCredentialOf = (bech32Address: string): string | null =>
  addressCredentials(bech32Address)?.payment.hex ?? null

// The bech32 limit is the spec's 90 characters; Cardano addresses run past it by
// design, so every caller has to pass a length that admits them.
const BECH32_LIMIT = 256

const decodeAddressHex = (bech32Address: string): string | null => {
  try {
    const {words} = bech32.decode(bech32Address as `${string}1${string}`, BECH32_LIMIT)
    const bytes = bech32.fromWords(words)
    return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  } catch (e) {
    // Not bech32 at all — a Byron address, or something that is not an address.
    // `debug` because that is an expected absence, not a failure. (A reward address
    // decodes fine and is rejected above instead, on having no payment half.)
    logger.debug('Address is not decodable bech32; its credentials are unknown', {
      origin: 'AddressCredentials',
      length: bech32Address.length,
      error: String(e),
    })
    return null
  }
}
