/**
 * Where a name's permit is minted, and why it is not the wallet's main address.
 *
 * `claimFreePermit` **discloses its recipient** — the address is a public argument of the circuit — and
 * the later `bind` spends that permit, so the two transactions publish a link between whatever address
 * received the permit and the name. Minting to the wallet's ordinary unshielded address would therefore
 * publish "this address owns this name", permanently, for a feature whose whole point is that a name is
 * how people reach you *without* your Pnyx ID.
 *
 * So each name gets its **own** address, at a derivation index that is a function of the name. Three
 * properties that matters for:
 *
 * - **Deterministic**, so a retry after a crash finds the permit that was already minted rather than
 *   minting a second one.
 * - **Per name**, so two names claimed by one wallet are not linked to each other either — a single
 *   dedicated "permits" address would have unlinked them from the main address and linked them to
 *   one another.
 * - **Spent to nothing.** `bind` consumes the permit, so the address is used exactly twice and never
 *   holds a balance. It needs no DUST: the sponsor pays the fee, and this key only signs the input.
 *
 * ⚠️ The wallet's unshielded sync takes **one address**, so a caller has to sync this one explicitly.
 * A permit at an unsynced address is invisible, and `bind` then reads as "not enough funds".
 *
 * @module
 */

import {pad32, persistentHash32} from '@pnyx/contract-client/derivations'

/** Domain separator for the index. Its own tag so this can never collide with a contract derivation. */
const DOMAIN = 'pnyx:permit-idx:v1'

/**
 * BIP32 non-hardened indices are 31 bits, so the hash is truncated rather than reduced modulo a
 * non-power-of-two — which would bias the low indices and, worse, make the mapping depend on a constant
 * nobody would think to keep.
 */
const INDEX_MASK = 0x7fffffff

/**
 * The derivation index of the address a name's permit is minted to.
 *
 * `canonicalName` is the **folded** 32-byte spelling, so `Alice` and `alice` — one name — resolve to one
 * permit address. A caller that passed the display spelling would mint to an address the retry could
 * not find.
 */
export const permitAddressIndex = (canonicalName: Uint8Array): number => {
  if (canonicalName.length !== 32) {
    throw new Error(`permitAddressIndex: a canonical handle is 32 bytes, got ${canonicalName.length}`)
  }
  const digest = persistentHash32([pad32(DOMAIN), canonicalName])
  // Big-endian over the first four bytes, masked to 31 bits. The mask is what bounds the result: a
  // leading byte ≥ 0x80 makes the shift negative, and `& 0x7fffffff` is a 32-bit op, so it lands in
  // range either way. Pinned by a test over names whose digests do start high.
  const raw =
    ((digest[0] as number) << 24) | ((digest[1] as number) << 16) | ((digest[2] as number) << 8) | (digest[3] as number)
  return raw & INDEX_MASK
}
