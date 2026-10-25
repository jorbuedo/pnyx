/**
 * Pure helpers for the notice registry.
 *
 * Lifts the route-matching and dismissal-serialization logic out of the
 * React hooks so it can be unit-tested without rendering — the hooks
 * layer just wires these up to `useContext` / storage adapters.
 *
 * @module
 */

import {logger} from '../logger'
import type {NoticeKey, NoticeValue} from './NoticeContext'

/**
 * Dismissals map a notice key to the {@link NoticeValue.revision} it was
 * dismissed at (the empty string for versionless notices). A dismissal only
 * suppresses the dot while the notice's current revision still matches — a
 * changed revision (e.g. a larger redeemable amount) re-arms it.
 */
export type Dismissals = ReadonlyMap<NoticeKey, string>

/** Normalize an optional revision to its canonical form. Versionless → `''`. */
const rev = (revision: string | undefined): string => revision ?? ''

/** Strip a single trailing slash. Leaves `/` alone. */
export const stripTrailingSlash = (route: string): string =>
  route.length > 1 && route.endsWith('/') ? route.slice(0, -1) : route

/**
 * Does the notice's `route` match (equal to, or a descendant of) the given
 * `target`? Descendants are defined by a literal path-segment prefix
 * (`/a/b` descends from `/a` but `/ab` does not).
 */
export const matchesRoute = (noticeRoute: string, target: string): boolean => {
  const normalized = stripTrailingSlash(target)
  if (noticeRoute === normalized) return true
  return noticeRoute.startsWith(`${normalized}/`)
}

/**
 * Is `notice` currently suppressed by a dismissal? True only when the key was
 * dismissed at the same revision the notice now carries — a revision change
 * invalidates the dismissal.
 */
export const isDismissed = (dismissals: Dismissals, key: NoticeKey, notice: NoticeValue): boolean =>
  dismissals.has(key) && dismissals.get(key) === rev(notice.revision)

/**
 * Should a consumer watching `target` show the attention dot?
 *
 * A notice contributes a dot when it is (a) currently active, (b) not
 * suppressed by a dismissal (dismissable entries only), and (c) anchored
 * at the target route or deeper.
 */
export const hasActiveDot = (
  notices: ReadonlyMap<NoticeKey, NoticeValue>,
  dismissals: Dismissals,
  target: string | readonly string[],
): boolean => {
  // ⚠️ **A surface can own more than one subtree, because nav order is not route order.** The Menu
  // tab is how you reach `/settings/security`, but that route does not descend from `/menu` — so a
  // single prefix could never light the tab that leads there, and seven of the eight sources
  // published into a dot nobody rendered.
  //
  // ⚠️ **And a broad prefix can claim a subtree it does not lead to.** `/settings` on the Menu tab
  // swallowed `/settings/wallet-settings`, which is reached only from Wallets — so a pending backup
  // lit Menu, where no row leads there, and left Wallets dark. A `!`-prefixed target subtracts a
  // subtree the broad prefix would otherwise take.
  const all = (typeof target === 'string' ? [target] : target).map(stripTrailingSlash)
  const excludes = all.filter((one) => one.startsWith('!')).map((one) => one.slice(1))
  const includes = all.filter((one) => !one.startsWith('!'))
  for (const [key, notice] of notices) {
    if (!notice.active) continue
    if (notice.dismissable && isDismissed(dismissals, key, notice)) continue
    if (excludes.some((one) => matchesRoute(notice.route, one))) continue
    if (includes.some((one) => matchesRoute(notice.route, one))) return true
  }
  return false
}

/**
 * Which keys should be newly dismissed when the user visits `route`, and at
 * what revision? Returns the subset of `notices` that are (a) dismissable,
 * (b) active, (c) anchored at `route` or deeper, and (d) not already
 * dismissed at their current revision. Separating the "which" from the "how"
 * lets the provider's state update stay a one-shot setState.
 */
export const findKeysToDismissAt = (
  notices: ReadonlyMap<NoticeKey, NoticeValue>,
  dismissals: Dismissals,
  route: string,
): ReadonlyMap<NoticeKey, string> => {
  const out = new Map<NoticeKey, string>()
  for (const [key, notice] of notices) {
    if (!notice.dismissable || !notice.active) continue
    if (isDismissed(dismissals, key, notice)) continue
    if (matchesRoute(notice.route, route)) out.set(key, rev(notice.revision))
  }
  return out
}

/**
 * Parse a persisted dismissals blob. Tolerates null, empty strings,
 * malformed JSON, and unexpected payloads by returning an empty map —
 * storage contents should never throw on app boot. Accepts the canonical
 * `[key, revision][]` shape; a bare `string[]` (a key with no revision) maps
 * to the versionless `''` revision.
 */
export const parseDismissals = (raw: string | null): Dismissals => {
  if (!raw) return new Map()
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return new Map()
    const out = new Map<NoticeKey, string>()
    for (const entry of parsed) {
      if (typeof entry === 'string') out.set(entry, '')
      else if (Array.isArray(entry) && typeof entry[0] === 'string')
        out.set(entry[0], typeof entry[1] === 'string' ? entry[1] : '')
    }
    return out
  } catch (e: unknown) {
    // An empty map matches no notice, which is also what a correct empty config produces.
    logger.warn('Notice matching config could not be read; no notice will match', {
      origin: 'notices/matching',
      error: String(e),
    })
    return new Map()
  }
}

/** Serialize for storage as `[key, revision][]`. Ordering isn't promised. */
export const serializeDismissals = (dismissals: Dismissals): string => JSON.stringify([...dismissals])
