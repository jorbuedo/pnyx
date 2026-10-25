/**
 * Which incoming system paths this app will honour, as a pure decision.
 *
 * ⚠️ **Deny by default.** Expo Router will navigate to any route path handed to it, so a
 * pass-through here means an outside party picks the screen. It picked more than the screen: a
 * `pnyx:///wallet/midnight/review?to=…&amount=…` link landed on a pre-filled send review with a Send
 * button — no link-action sheet, no account choice, none of the consent `utils/qr-actions.ts` exists to
 * take away from a URL ("*someone else's URL opened the app. Nothing acts on its own there*"). Same
 * shape for the browser and every dev screen. That is what this module closes.
 *
 * ## The rule
 *
 * | incoming | decision | why |
 * |---|---|---|
 * | `web+cardano:…`, `<scheme>://<brand-authority>/…`, `https://<brand-authority>/…` | `dispatch` | the in-app dispatcher lands these on `/wallet/link-action`, which asks which wallet and waits |
 * | `/settings/dev/…`, **dev builds only** | `route` | the committed probe screens, reachable as `docs/DIRECT_MESSAGES_PLAN.md` documents |
 * | anything else | `deny` | not a surface. Returning it would let a link choose the screen |
 *
 * ⚠️ **Nothing in a shipped build mounts a route.** Every link either reaches the sheet or is refused.
 * A future feature with a provider callback needs a row in this table *and* a route that exists — an
 * earlier rewriter here pointed links at a route tree that had already been deleted.
 *
 * `deny` is a real answer, not a redirect: `redirectSystemPath` returning a falsy value cancels the
 * navigation ("*no redirection occurs and the app stays on the current path*" — expo-router's
 * `NativeIntent` type), so the app opens where it would have opened and nothing is acted on.
 *
 * ⚠️ **`dispatch` is not "ignore".** The URL still reaches `useDeepLinkHandler` through
 * `Linking.getInitialURL()` / the `url` event, which is what carries it to the sheet. Only Expo
 * Router's own navigation is being steered here.
 *
 * @module
 */

import {needsManualDispatch} from '../hooks/deep-link-dispatch'
import {logger} from '../logger'

const ORIGIN = 'deep-link-approval'

/** Dev-tools screens live under one prefix, so the dev exception can name it rather than mean "anything". */
const DEV_ROUTE_PREFIX = '/settings/dev/'

export type SystemPathDecision =
  /** Hand this exact path to Expo Router. */
  | {readonly kind: 'route'; readonly path: string}
  /** Open the app at its root and let the in-app dispatcher take the URL to the link-action sheet. */
  | {readonly kind: 'dispatch'}
  /** Navigate nowhere. `reason` is for the log — nothing user-facing claims a link was honoured. */
  | {readonly kind: 'deny'; readonly reason: string}
  /**
   * There was no link: the OS handed over the bare scheme (`pnyx:///`), which is what a cold launch
   * from the launcher icon looks like.
   *
   * Distinct from `deny` because it is not a refusal — nobody's link was dropped — and conflating the
   * two put a warning in the log on every single launch. That trains the reader to skip the one line
   * that matters when a real link *is* refused, which is the whole reason this rule is logged at all.
   */
  | {readonly kind: 'no-link'}

export type ApproveSystemPathParams = {
  /** The raw path or URL as `redirectSystemPath` received it. */
  readonly path: string
  /** The app's own URL scheme, e.g. `pnyx`. */
  readonly brandScheme: string
  /**
   * Whether the dev-tools route prefix is reachable by link.
   *
   * Required rather than defaulted, and passed as `__DEV__` by the only caller: a default of `true`
   * would ship the affordance, and a default of `false` would silently break the documented probe
   * links the moment someone forgot the argument.
   */
  readonly allowDevRoutes: boolean
}

/**
 * An incoming link as a `URL`, or `null` when it is not one.
 *
 * Parsed **once** and read for both facts below. Two parses meant two `try`s for the same string, and
 * the second one had nothing to say that the first had not already logged.
 *
 * ⚠️ `pnyx://settings/dev/x` puts `settings` in the *authority*, so its pathname is `/dev/x` and it is
 * not the dev prefix. That two-slash form has never landed — see the note in
 * `docs/DIRECT_MESSAGES_PLAN.md` — and it stays denied rather than being repaired here.
 */
const readUrl = (raw: string): URL | null => {
  try {
    return new URL(raw)
  } catch (error) {
    // An expected absence rather than a fault — anything can be handed to this app — but it decides
    // which branch runs below, so it is worth being able to see.
    logger.debug('an incoming link is not a readable URL', {origin: ORIGIN, error: String(error)})
    return null
  }
}

/**
 * A URL with a scheme and *nothing else* — `pnyx://` or `pnyx:///`, which is what a cold launch from
 * the launcher icon hands over.
 *
 * ⚠️ Every part has to be empty, not just the pathname: `pnyx://send` parses with an empty pathname
 * too, because `send` lands in the authority, and that one is a link somebody sent us and must stay
 * denied. The caller's own version of this test compared the raw string to `'/'`, which the string it
 * holds (`pnyx:///`) never equals — so it warned on every launch instead.
 */
const isBareSchemeUrl = (url: URL): boolean =>
  url.host === '' && (url.pathname === '' || url.pathname === '/') && url.search === '' && url.hash === ''

/**
 * Whether this app honours `path`, and how.
 *
 * Split from `+native-intent.tsx` so the rule is testable without the route file's import graph, and
 * so the table above has one implementation rather than a copy per caller.
 */
export const approveSystemPath = ({path, brandScheme, allowDevRoutes}: ApproveSystemPathParams): SystemPathDecision => {
  const trimmed = path.trim()
  if (trimmed.length === 0) return {kind: 'deny', reason: 'an empty path'}

  // A bare path (`/wallet`) is not a URL and never a launch; everything else is read as one.
  const url = trimmed.startsWith('/') ? null : readUrl(trimmed)
  if (url !== null && isBareSchemeUrl(url)) return {kind: 'no-link'}
  const pathname = trimmed.startsWith('/') ? trimmed : (url?.pathname ?? null)
  if (pathname !== null && allowDevRoutes && pathname.startsWith(DEV_ROUTE_PREFIX)) {
    return {kind: 'route', path: trimmed}
  }

  // ⚠️ Asked before `needsManualDispatch`, which reads an unparsable string as one for the sheet. A
  // bare path is not a designed shape — every one of those carries a scheme — so `/wallet` must not
  // reach the dispatcher and be answered with an "unsupported link" alert about a route we simply
  // refuse to navigate to.
  if (trimmed.startsWith('/')) return {kind: 'deny', reason: `${trimmed} is not an approved route`}

  if (needsManualDispatch(trimmed, brandScheme)) return {kind: 'dispatch'}

  const named = pathname ?? trimmed
  return {
    kind: 'deny',
    reason: allowDevRoutes
      ? `${named} is not an approved route (dev builds also allow ${DEV_ROUTE_PREFIX}…)`
      : `${named} is not an approved route`,
  }
}
