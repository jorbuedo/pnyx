/**
 * QR code content parser.
 *
 * Classifies scanned QR content into action types for routing.
 *
 * Detection order:
 * 1. Cardano URI (web+cardano://... or legacy web+cardano:<address>) - parsed with @pnyx/links
 * 2. Brand-specific link (pnyx://...) - parsed with @pnyx/links
 * 2a. App-scheme fallback — try the pnyx:// scheme if it wasn't already tried
 * 3. Cardano address (addr1... or addr_test1...)
 * 4. URL (https:// or http://)
 * 5. A bare `pnyx_id1…` — an identity, which this app's own ID screen puts in a QR verbatim
 * 6. Unknown - anything else
 *
 * @module
 */

import {decodePnyxId} from '@pnyx/contract-client/identity'
import type {BrandAction, ParsedUri} from '@pnyx/links'
import {isBrandLink, isCardanoUri, PNYX_SCHEME, parse, parseBrandLink} from '@pnyx/links'
import {Effect} from 'effect'
import {logger} from '../logger'

/**
 * Maximum byte length accepted for QR/deep-link content.
 * Partner deep links can carry nested return URLs and signed provider state,
 * so this needs enough headroom for real partner callbacks while still
 * rejecting obviously oversized payloads.
 */
export const MAX_LINK_BYTES = 8192

export type QrAction =
  | {type: 'address'; address: string; network: 'mainnet' | 'testnet'}
  | {type: 'cardanoUri'; parsed: ParsedUri; raw: string}
  // `raw` for the same reason `cardanoUri` carries it: a co-signer key is read back through
  // `parseCoSignerValue`, which takes the link, not the already-split params. Required rather than
  // optional so a new construction site cannot forget it and silently lose the only path to that.
  | {type: 'brandLink'; action: BrandAction; raw: string}
  | {type: 'url'; url: string}
  /** Someone's identity, ready to open a conversation with. Always the canonical lower-case form. */
  | {type: 'pnyxId'; pnyxId: string}
  | {type: 'unknown'; raw: string}

const CARDANO_ADDRESS_REGEX = /^addr(_test)?1[a-z0-9]+$/i

/** Cheap shape gate before the checksum: bech32m's own alphabet, with the identity HRP. */
const PNYX_ID_REGEX = /^pnyx_id1[a-z0-9]+$/i

/**
 * A validated `pnyx_id`, or `null` for anything that is not one.
 *
 * ⚠️ **The checksum is the point.** A mistyped or damaged id that merely *looks* right must not reach
 * a lookup, where its absence would read as "that person is not registered" — a wrong answer about
 * somebody else. `decodePnyxId` throws on a bad checksum, a foreign HRP or a wrong-length payload.
 *
 * Lower-cased on the way out because bech32m is case-insensitive and an all-upper QR — which encoders
 * prefer, it packs denser — is the same identity. That is the canonical spelling `encodePnyxId`
 * produces, not a guess.
 */
const readPnyxId = (value: string): string | null => {
  if (!PNYX_ID_REGEX.test(value)) return null
  try {
    decodePnyxId(value)
  } catch (error) {
    // Distinct from "not an id at all", which is the silent common case: this one was aimed at us and
    // missed, and it is the only evidence a user has that their code is damaged rather than unknown.
    logger.info('QR: pnyx_id-shaped content that did not decode', {origin: 'qr-parser', error: String(error)})
    return null
  }
  return value.toLowerCase()
}

/**
 * Decodes a percent-encoded string without throwing on malformed sequences.
 * `decodeURIComponent` throws `URIError` for invalid sequences like `%GG`.
 */
function safeDecodeUri(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch (e: unknown) {
    // Returning the raw string is right for a scanned payload that is not percent-encoded.
    logger.debug('Scanned value could not be percent-decoded; using it raw', {
      origin: 'qr-parser',
      error: String(e),
    })
    return s
  }
}

/**
 * Parse QR code content into a typed action.
 *
 * @param data - Raw QR code content
 * @param brandScheme - Optional brand scheme (e.g. "pnyx") to detect brand-specific links
 */
export function parseQrContent(data: string, brandScheme?: string): QrAction {
  if (data.length > MAX_LINK_BYTES) return {type: 'unknown', raw: ''}

  const trimmed = data.trim()
  // Decode percent-encoded content (e.g. QR codes may contain web%2Bcardano%3A%2F%2F...).
  // Brand link checks keep `trimmed` so parseBrandLink / new URL() handles encoding natively;
  // pre-decoding there would cause %2B ('+') to be misread as space by URLSearchParams.
  const decoded = safeDecodeUri(trimmed)

  // 1. Cardano URI (web+cardano://... or legacy web+cardano:<address>),
  //    including the CIP-0301 web+cardano://backup encrypted-export link
  if (isCardanoUri(decoded)) {
    const result = Effect.runSync(Effect.either(parse(decoded)))
    if (result._tag === 'Right') {
      return {type: 'cardanoUri', parsed: result.right, raw: decoded}
    }
    // If parsing fails, fall through to other checks
  }

  // 2. Brand-specific link (pnyx://...) — use trimmed (original encoded form)
  if (isBrandLink(trimmed, brandScheme)) {
    const action = parseBrandLink(trimmed, brandScheme)
    if (action) {
      return {type: 'brandLink', action, raw: trimmed}
    }
  }

  // 2a. App-scheme fallback — recognise pnyx:// links even when brandScheme wasn't passed.
  if (PNYX_SCHEME !== brandScheme) {
    const action = parseBrandLink(trimmed, PNYX_SCHEME)
    if (action) return {type: 'brandLink', action, raw: trimmed}
  }

  // 3. Cardano address
  if (CARDANO_ADDRESS_REGEX.test(decoded)) {
    const network = decoded.toLowerCase().startsWith('addr_test') ? 'testnet' : 'mainnet'
    return {type: 'address', address: decoded, network}
  }

  // 4. URL — return trimmed to preserve original percent-encoding (browser normalises on load)
  if (/^https?:\/\//i.test(trimmed)) {
    return {type: 'url', url: trimmed}
  }

  // 5. A bare identity. Below the URL check because it cannot collide with one, and above `unknown`
  //    because this app's own ID screen encodes exactly this string into its QR.
  const pnyxId = readPnyxId(decoded)
  if (pnyxId !== null) return {type: 'pnyxId', pnyxId}

  // 6. Unknown — return decoded for human-readable raw content
  return {type: 'unknown', raw: decoded}
}
