import {brand} from '../src/brand'
import {logger} from '../src/logger'
import {approveSystemPath} from '../src/services/deep-link-approval'

/**
 * Decide what Expo Router does with an incoming link.
 *
 * ⚠️ **Deny by default** — the rule and its reasoning live in
 * `src/services/deep-link-approval.ts`. This used to end with `return path`, which let any URL from
 * outside the app pick any route: `pnyx:///wallet/midnight/review?to=…&amount=…` opened a pre-filled
 * send review, skipping the link-action sheet that exists to ask which wallet is acting.
 *
 * A denial returns `null`, which expo-router documents as "no redirection occurs and the app stays on
 * the current path" — so the app opens where it would have opened and the link is not honoured. It is
 * logged at `warn` because a dropped link is a thing the user did that produced nothing.
 */
export function redirectSystemPath({path, initial}: {path: string; initial: boolean}): string | null {
  try {
    const normalizedPath = path.trim()
    const parsedPath = (() => {
      try {
        return decodeURIComponent(normalizedPath)
      } catch (error) {
        // A malformed escape is not a fault of ours, but the decision below runs on whichever string
        // this returns, so which one it was must be visible.
        logger.debug('an incoming link is not decodable; deciding on the raw path', {
          origin: '+native-intent',
          error: String(error),
        })
        return normalizedPath
      }
    })()

    const decision = approveSystemPath({
      path: parsedPath,
      brandScheme: brand.scheme,
      // `__DEV__` only: the committed probe screens stay link-reachable while driving a debug build,
      // and a shipped build has no link-reachable dev route at all.
      allowDevRoutes: __DEV__,
    })

    if (decision.kind === 'route') {
      logger.info('Approved deep link — routing to an Expo path', {
        origin: '+native-intent',
        path: parsedPath,
        rewrittenPath: decision.path,
        initial,
      })
      return decision.path
    }

    if (decision.kind === 'dispatch') {
      // `useDeepLinkHandler` picks the URL up from `Linking.getInitialURL()` / the `url` event and
      // lands it on `/wallet/link-action`. Root rather than the raw URL, which Expo Router cannot
      // resolve as a route.
      logger.info('Deep link handed to the in-app dispatcher', {
        origin: '+native-intent',
        path: parsedPath,
        initial,
      })
      return '/'
    }

    if (decision.kind === 'no-link') {
      // The launcher icon, not a dropped link. Debug so a real refusal below stays
      // the only warning this module emits.
      logger.debug('Launch carried no deep-link path', {origin: '+native-intent', path: parsedPath, initial})
      return null
    }

    logger.warn('Refused a deep link that is not an approved route', {
      origin: '+native-intent',
      path: parsedPath,
      reason: decision.reason,
      initial,
    })
    return null
  } catch (error) {
    // Deny by default: an unreadable link is not a reason to navigate anywhere.
    logger.warn('Could not decide on an incoming link; it is not honoured', {
      origin: '+native-intent',
      error: String(error),
      initial,
    })
    return null
  }
}
