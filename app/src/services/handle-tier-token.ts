/**
 * A ticket's colour: the token type its permits are minted as.
 *
 * Derived, never fetched — plain SHA-256 over the payment contract and the tier's domain
 * (`customUnshieldedTokenType`). A misconfigured address yields no colour rather than a wrong one,
 * which is why the address is decoded rather than cast.
 *
 * Its own module because two surfaces show the colour — the ticket row and the info sheet — and a
 * second copy of the decode is a second place for the 32-byte check to be dropped.
 *
 * @module
 */

import {permitTokenType} from '@pnyx/contract-client/derivations'
import {hex} from '@pnyx/crypto'
import {Either} from 'effect'
import {logger} from '../logger'
import {truncateMiddle} from '../utils/truncate'

/**
 * The payment contract's 32 bytes, or `undefined` when the configured address is not one.
 *
 * ⚠️ The two ways of having no contract are different facts and only one is a problem: nothing
 * configured is how a build without the payment contract is *meant* to read, while an address that
 * will not decode is a misconfiguration that would otherwise show up only as five missing colours.
 */
export const permitContract = (payment: string | undefined): Uint8Array | undefined => {
  if (payment === undefined) return undefined

  const decoded = hex.decode(payment)
  if (Either.isLeft(decoded) || decoded.right.length !== 32) {
    logger.warn('The configured payment address is not 32 bytes of hex, so no ticket has a colour', {
      origin: 'permitContract',
      length: Either.isLeft(decoded) ? null : decoded.right.length,
    })
    return undefined
  }

  return decoded.right
}

/** The colour a tier's permits carry, as hex. */
export const permitColour = (contract: Uint8Array, tier: number): string => hex.encode(permitTokenType(contract, tier))

/**
 * The colour as a ticket row shows it.
 *
 * Its own budget rather than one of `truncate.ts`'s, which size a value against a label — this one
 * shares a row with a name, a button and a count. Six each side is enough to tell two tiers' colours
 * apart at a glance, which is all the row is for; the full value is in the info sheet.
 */
export const truncateColour = (colour: string): string => truncateMiddle(colour, 6, 6)
