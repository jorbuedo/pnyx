/**
 * Allowlist check for **push-notification deep links**.
 *
 * The remote config ships a record of allowed URL prefixes under
 * `allowedLinks` (keys are opaque identifiers, values are URL prefixes).
 * The only consumer is the push-notification handler
 * ({@link ../platform/notification-tools}), which receives URLs from the
 * push provider — a control plane *outside* of the remote-config repo.
 * The allowlist is the boundary between "URL from push payload" and
 * `Linking.openURL`.
 *
 * **Not for banner / in-app CTAs.** Those URLs already live in the same
 * remote-config JSON as the allowlist, so checking against the allowlist
 * provides no defense — anyone able to push a malicious banner can also
 * push themselves onto the allowlist in the same commit. If you're
 * tempted to reach for this check from inside the remote-config control
 * plane, don't — the banner JSON is the source of truth there.
 *
 * The check is synchronous and the cache is kept in this module's scope
 * so callers outside of React context (background push handlers, notifee
 * setup) can use it without a hook.
 *
 * {@link ConfigProvider} is the single writer: when it loads or
 * refreshes remote config, it calls {@link setAllowedLinks}. Before that
 * write happens (app boot, offline first run, fetch failure with no
 * cache) the allowlist is `undefined` and every external link is
 * rejected — safer than pretending everything is fine.
 *
 * @module
 */

import type {RemoteAllowedNotificationLinks} from '@pnyx/config'
import {logger} from '../logger'

let cachedAllowedLinks: RemoteAllowedNotificationLinks | undefined

/**
 * Set the cached allowlist. Called by ConfigProvider whenever remote
 * config becomes available or changes. Pass `undefined` to clear —
 * e.g. on a failed refresh that invalidates a previously-cached value
 * (not used today; current callers only set, never clear).
 */
export const setAllowedLinks = (allowedLinks: RemoteAllowedNotificationLinks | undefined): void => {
  cachedAllowedLinks = allowedLinks
}

/**
 * Current snapshot — exported mainly for tests. Hot-path callers should
 * go through {@link isAllowedExternalLink} instead of inspecting the
 * record themselves, so the matching semantics stay in one place.
 */
export const getAllowedLinksSnapshot = (): RemoteAllowedNotificationLinks | undefined => cachedAllowedLinks

/**
 * Return `true` when `link` is on the allowlist.
 *
 * Matching is **origin-exact** + **path-prefix**:
 * - `link` and the allowlisted prefix must share the same origin
 *   (protocol + host + port). A prefix of `https://pnyx.pxkq.uk/x/` does
 *   NOT match `https://pnyx.pxkq.uk.evil.com/x/y` — raw string prefix
 *   matching would have, which is why we don't use that.
 * - `link`'s pathname must start with the prefix's pathname, with a
 *   separator boundary so `/campaign/` doesn't match `/campaigns`.
 *
 * Unparseable inputs (malformed prefix or link) are silently skipped
 * rather than thrown — this is called on remote-controlled data from
 * push payloads, and a bad entry shouldn't block the rest of the
 * allowlist.
 *
 * Internal routes (`/…`) are **not** handled here; they're the
 * caller's responsibility to identify and dispatch separately. This
 * helper is specifically for the external-URL path.
 *
 * When the allowlist is empty / absent, every external link is rejected.
 */
export const isAllowedExternalLink = (
  link: string,
  allowedLinks: RemoteAllowedNotificationLinks | undefined = cachedAllowedLinks,
): boolean => {
  if (!allowedLinks) return false

  let linkUrl: URL
  try {
    linkUrl = new URL(link)
  } catch (e: unknown) {
    // Denying is correct for an unparseable link, and this is an untrusted input — but a link
    // refused because it is malformed and one refused because it is not on the list are
    // different findings if anyone is ever asked why a link did not open.
    logger.debug('Link is not a parseable URL; refusing it', {origin: 'allowed-links', error: String(e)})
    return false
  }

  for (const prefix of Object.values(allowedLinks)) {
    if (!prefix) continue
    if (matchesAllowedPrefix(linkUrl, prefix)) return true
  }
  return false
}

/**
 * Check a single allowlist prefix against the parsed link URL. Origin
 * must match exactly; pathname must start with the prefix's pathname
 * at a separator boundary so `/camp/` doesn't accidentally match
 * `/camping/`.
 */
const matchesAllowedPrefix = (linkUrl: URL, prefix: string): boolean => {
  let prefixUrl: URL
  try {
    prefixUrl = new URL(prefix)
  } catch (e: unknown) {
    // This one is OUR configuration, not user input: a prefix that will not parse silently
    // stops matching and every link under it is refused.
    logger.warn('Allowed-link prefix is not a parseable URL; nothing will match it', {
      origin: 'allowed-links',
      prefix,
      error: String(e),
    })
    return false
  }

  if (linkUrl.origin !== prefixUrl.origin) return false

  const linkPath = linkUrl.pathname
  const prefixPath = prefixUrl.pathname
  if (linkPath === prefixPath) return true
  // Path-prefix with boundary: either the prefix already ends in `/`,
  // or the link's next character after the prefix is `/`. Prevents
  // `/camp/` ⊂ `/camping/` false positives.
  if (prefixPath.endsWith('/')) return linkPath.startsWith(prefixPath)
  return linkPath.startsWith(`${prefixPath}/`)
}
