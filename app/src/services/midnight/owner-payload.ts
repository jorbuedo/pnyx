/**
 * A `mn_addr…` as the 32-byte owner a transaction's own facts report.
 *
 * ⚠️ **One rule, two callers, and it must be the same one.** An unshielded offer names an owner as a
 * 32-byte `UserAddress` (hex); the wallet holds its addresses in bech32. Whoever compares the two has
 * to convert, and a caller that compared bech32 against hex would find no match at all — so every one
 * of its own addresses would read as a stranger's, and a co-funded contributor's own change would be
 * reported as a payment out. The review screen and the agent read both go through here.
 *
 * @module
 */

import {hex} from '@pnyx/crypto'
import {encodeNightAddress, parseMidnightAddress} from '@pnyx/wallet'
import {logger} from '../../logger'

const ORIGIN = 'midnight-owner-payload'

/**
 * The owner payload a Midnight address carries, lowercased hex, or `null` for anything else.
 *
 * `null` for a shielded address too: those carry coin and encryption keys, not a `UserAddress`, and
 * nothing in an unshielded offer would ever match one.
 */
export const midnightOwnerPayload = (address: string): string | null => {
  const parsed = parseMidnightAddress(address)
  return parsed.ok && parsed.kind === 'night' ? hex.encode(parsed.payload).toLowerCase() : null
}

/**
 * The `mn_addr…` an owner payload belongs to — the inverse of {@link midnightOwnerPayload}.
 *
 * ⚠️ **A review screen must not show a person a raw owner.** A transaction's facts name owners as
 * 32-byte `UserAddress` hex, because that is how the offer names them; a person checking "is this the
 * address I gave the agent?" has only the bech32 form to compare against, and cannot do that against
 * hex. Rendering the payload instead of the address made the recipient of an agent's transaction
 * unverifiable by eye on 2026-08-29.
 *
 * `null` when the payload is not 32 bytes — a shape this cannot honestly render as an address, and one
 * a caller should fall back to showing verbatim rather than dressing up.
 */
export const midnightAddressOfOwner = (ownerHex: string, networkId: string): string | null => {
  const decoded = hex.decode(ownerHex)
  if (decoded._tag === 'Left' || decoded.right.length !== 32) return null
  try {
    return encodeNightAddress(decoded.right, networkId)
  } catch (error) {
    // A network id the encoder will not accept. The caller falls back to the raw owner, which is worse
    // to read but true — a wrong-network address would be worse still. Logged because a review screen
    // quietly showing hex instead of an address is exactly the kind of degradation nobody reports.
    logger.warn('an owner could not be rendered as an address; showing the raw payload', {
      origin: ORIGIN,
      networkId,
      error: String(error),
    })
    return null
  }
}
