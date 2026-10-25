import {BRAND_LINK_AUTHORITIES, PNYX_SCHEME} from '@pnyx/links'
import {logger} from '../logger'

/**
 * Returns true only for URLs that Expo Router cannot handle on its own and
 * therefore need manual dispatch via the QR action pipeline:
 *
 * - web+cardano://...          — Cardano URIs (no Expo route)
 * - <scheme>://<brand-authority>/...  — partner integration links (no Expo route)
 * - https://<brand-authority>/...     — HTTPS fallback for partner links
 *
 * Brand-scheme URLs with any other hostname are refused by
 * `services/deep-link-approval.ts` rather than dispatched, so they produce
 * neither a navigation nor an alert.
 */
export function needsManualDispatch(url: string, brandScheme: string): boolean {
  if (url.startsWith('web+cardano:')) return true
  try {
    const parsed = new URL(url)
    const scheme = parsed.protocol.replace(/:$/, '')
    if (scheme === brandScheme || scheme === PNYX_SCHEME || parsed.protocol === 'https:') {
      return (BRAND_LINK_AUTHORITIES as readonly string[]).includes(parsed.hostname)
    }
  } catch (e: unknown) {
    // malformed URL — let parseQrContent classify as 'unknown'
    logger.debug('Deep link is not a parseable URL; handing it to the QR classifier', {
      origin: 'deep-link-dispatch',
      error: String(e),
    })
    return true
  }
  return false
}
