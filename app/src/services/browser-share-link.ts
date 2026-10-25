/**
 * The two spellings of "this page", and which surface gets which.
 *
 * **Out of Pnyx: the ordinary `https:` URL.** The clipboard and the OS share sheet lead somewhere we
 * do not control — a browser, a notes app, someone else's chat — and none of those can open a
 * `web+cardano:` URI. A link that only works inside this app is a broken link everywhere else.
 *
 * **Into a Pnyx conversation: a CIP-0158 `browse` URI.** {@link module:./link-action} classifies one
 * as `kind: 'dapp'` and the thread draws it as a card naming the host, which taps through to the
 * in-app browser — instead of a raw URL the reader has to squint at. CIP-0158 rather than a
 * `pnyx://` spelling of our own, for the reason `link-action` gives: a card that only worked between
 * two copies of this app would work nowhere else.
 *
 * `readLinkAction` matches the **whole trimmed body**, so the composer gets the URI and nothing else.
 * Anything appended alongside it turns the card back into chat.
 *
 * @module
 */

import {build} from '@pnyx/links'
import {logger} from '../logger'

const ORIGIN = 'browser-share-link'

/** CIP-0158 restricts the embedded `uri` to these, and so does the parser on the way back in. */
const CARD_ABLE_PROTOCOLS = new Set(['http:', 'https:'])

/**
 * The message body for sharing `url` into a Pnyx conversation.
 *
 * Falls back to the plain URL when the browse authority could not carry it — a non-http(s) scheme, or
 * a string that is not a URL at all. That degrades to an ordinary chat message, which is honest; the
 * alternative is posting a `web+cardano:` URI the reader's client will refuse to card and render as a
 * wall of percent-encoding.
 */
export const inAppShareBody = (url: string): string => {
  let protocol: string
  try {
    protocol = new URL(url).protocol
  } catch (e: unknown) {
    logger.debug('sharing a non-URL as plain text', {origin: ORIGIN, error: String(e)})
    return url
  }
  if (!CARD_ABLE_PROTOCOLS.has(protocol)) {
    logger.debug('sharing a non-http(s) URL as plain text', {origin: ORIGIN, protocol})
    return url
  }
  return build({authority: 'browse', version: 'v1', uri: url})
}
