/**
 * What the user typed into a "message someone" field: an Pnyx id, or an Pnyx handle.
 *
 * The id is decided by an actual bech32m decode rather than a prefix test, for the same reason
 * {@link module:./pnyx-forum} does: `pnyx_id…` is a checksummed encoding, and a string that merely
 * starts with the prefix is not an identity. Treating a malformed one as an identity sends the user
 * into a row lookup that can only fail confusingly.
 *
 * The identity is returned **re-encoded from its decoded bytes**, not as typed. `conversationId`
 * pairs the two ids as strings, so a peer who pasted an uppercase bech32 (which decodes fine) would
 * otherwise name a different conversation than the peer who typed it lowercase.
 *
 * **Handles carry no suffix.** A dotted name belongs to another naming system (`.night`, `.eth`), so
 * anything with a dot in it is not a Pnyx handle. ⚠️ That is checked *in this module* — the handle
 * charset admits `.` like any other punctuation, so nothing below this layer will refuse one.
 *
 * @module
 */

import {encodeHandle, validateHandle} from '@pnyx/contract-client/handle'
import {decodePnyxId, encodePnyxId} from '@pnyx/contract-client/identity'
import {logger} from '../logger'

export type PeerInput =
  /** A well-formed `pnyx_id`, canonicalised; use it directly, no lookup involved. */
  | {readonly kind: 'identity'; readonly pnyxId: string}
  /**
   * An Pnyx handle that passes the client policy; resolve it against `names` to get a `C`.
   *
   * `nameKey` is the **padded 32-byte** field the map is keyed by — deliberately not named `bytes`,
   * which on `HandleCheck` means the unpadded UTF-8 and would silently miss every lookup.
   */
  | {readonly kind: 'handle'; readonly handle: string; readonly nameKey: Uint8Array}
  | {readonly kind: 'empty'}
  /** Neither. Telling the user this is better than failing later as "peer not found". */
  | {readonly kind: 'unrecognised'}

/**
 * Classify raw input. Whitespace at the edges is stripped — bech32 contains none, and
 * `canonicalizeHandle` trims anyway — so this only forgives a paste, never alters a value's meaning.
 */
export const classifyPeerInput = (raw: string): PeerInput => {
  const trimmed = raw.trim()
  if (trimmed === '') return {kind: 'empty'}
  try {
    const {identity} = decodePnyxId(trimmed)
    return {kind: 'identity', pnyxId: encodePnyxId(identity)}
  } catch (e: unknown) {
    // Not an identity; fall through to the handle test rather than reporting a bech32 error, since
    // "alice" is a perfectly reasonable thing to have typed. Debug, because the throw is the probe.
    logger.debug('Peer input is not a pnyx_id; trying it as a handle', {
      origin: 'peer-input',
      error: String(e),
    })
  }
  // ⚠️ **The dot rule is enforced here, not by the charset.** It used to fall out of the allowlist:
  // `.` was not an admitted character, so `alice.night` failed `validateHandle` on its own. The charset
  // is a denylist now and admits every assigned character, punctuation included — so a suffixed name
  // classifies as a perfectly valid handle unless this layer says otherwise. It has to, because
  // deciding *which naming system* an input belongs to is this function's job and never was the
  // charset's.
  if (trimmed.includes('.')) return {kind: 'unrecognised'}
  const check = validateHandle(trimmed)
  return check.ok ? {kind: 'handle', handle: check.handle, nameKey: encodeHandle(check.handle)} : {kind: 'unrecognised'}
}
