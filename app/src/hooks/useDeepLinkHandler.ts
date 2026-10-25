/**
 * Deep link handler hook.
 *
 * Listens for incoming deep links (cold-start via getInitialURL and
 * background via Linking.addEventListener) and routes them using the
 * same parser + action router as the QR scanner.
 *
 * **The router is shared; the consent is not.** A scan is a deliberate act — the
 * user pointed a camera at something in front of them. A deep link is somebody
 * else's URL opening the app, so everything from here lands on the link-action
 * sheet first and the user proceeds, rather than the app acting on arrival.
 *
 * Must be called in the root layout so it is always active.
 *
 * @module
 */

import {useRouter} from 'expo-router'
import {useEffect} from 'react'
import {Linking} from 'react-native'
import {brand} from '../brand'
import {logger} from '../logger'
import {platformIsWeb} from '../platform'
import {useI18n} from '../providers/I18nProvider'
import {type HandleQrActionOptions, handleQrAction} from '../utils/qr-actions'
import {MAX_LINK_BYTES, parseQrContent} from '../utils/qr-parser'
import {needsManualDispatch} from './deep-link-dispatch'
import {useLatestRef} from './useLatestRef'

export function dispatchDeepLink(
  url: string,
  router: ReturnType<typeof useRouter>,
  t: ReturnType<typeof useI18n>['t'],
  options?: HandleQrActionOptions,
): void {
  logger.info('[DeepLink] received', {url})
  if (url.length > MAX_LINK_BYTES) {
    logger.warn('[DeepLink] rejected: URL exceeds size limit', {length: url.length})
    return
  }
  if (!needsManualDispatch(url, brand.scheme)) {
    logger.info('[DeepLink] delegating to Expo Router', {url})
    return
  }
  const action = parseQrContent(url, brand.scheme)
  // `deep-link`, always: this function only ever runs for a URL that opened the
  // app from outside it. Nothing on that path acts on its own — see the `source`
  // doc on `HandleQrActionOptions`.
  handleQrAction(action, router, t, {...options, source: 'deep-link'})
}

/**
 * Subscribe to incoming deep links and route them to the appropriate screen.
 *
 * Handles both cold-start URLs (via `Linking.getInitialURL`) and URLs
 * received while the app is already running (via `Linking.addEventListener`).
 * No-op on web — web deep links are handled natively by Expo Router's URL routing.
 */
export function useDeepLinkHandler(options?: HandleQrActionOptions): void {
  const router = useRouter()
  const {t} = useI18n()

  // `t` is only used by `handleQrAction` for localized error alerts. Keeping
  // it in a ref means a locale switch doesn't re-subscribe the listener +
  // re-invoke `Linking.getInitialURL()` — that would re-fire the cold-start
  // URL and surprise the user with an unexpected navigation. The dispatcher
  // reads the ref at call time so alerts still use the current locale.
  const tRef = useLatestRef(t)
  const optionsRef = useLatestRef(options)

  useEffect(() => {
    if (platformIsWeb) return

    // Cold-start: process the URL that launched the app (if any).
    // Deferred by one event-loop tick (via Promise.resolve) plus a short
    // timeout to let Expo Router complete its initial mount and navigation
    // before we push a new route on top. Expo Router has no stable
    // "router.isReady" API in v3, so a minimal delay is the accepted pattern.
    void Linking.getInitialURL().then((url) => {
      if (!url) return
      setTimeout(() => dispatchDeepLink(url, router, tRef.current, optionsRef.current), 300)
    })

    // Foreground / background → foreground: process links while app is running.
    const subscription = Linking.addEventListener('url', ({url}) => {
      dispatchDeepLink(url, router, tRef.current, optionsRef.current)
    })

    return () => subscription.remove()
  }, [router])
}
