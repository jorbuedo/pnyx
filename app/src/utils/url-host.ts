/**
 * The host of a link, when it is one a card may offer to open.
 *
 * `null` for anything that is not `http(s)` or carries no host. Both halves
 * matter: a card that cannot name where it goes is the one thing an "open this"
 * affordance must never be, and a `javascript:` or custom-scheme URL is not a
 * page at all.
 *
 * Shared by the classifier and the QR / deep-link router so the two cannot
 * disagree about which URLs are openable — the router refusing something the
 * classifier would card, or worse, the reverse.
 *
 * @module
 */

import {logger} from '../logger'

export const hostOfUrl = (url: string): string | null => {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
    return parsed.host === '' ? null : parsed.host
  } catch (e: unknown) {
    logger.debug('URL host could not be read', {origin: 'url-host', error: String(e)})
    return null
  }
}
