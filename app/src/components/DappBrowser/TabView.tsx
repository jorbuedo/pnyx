/**
 * Per-tab WebView wrapper.
 *
 * Owns the actual `<WebView>` instance for one browser tab. All tabs are
 * mounted as siblings in the screen — only the active one is shown
 * (`display: 'flex'`); the rest are hidden (`display: 'none'`) so their
 * page state (scroll, form input, dApp session) survives tab switches.
 *
 * Each tab gets its own session id baked into the dApp injection script,
 * so dApp requests are scoped to the tab that issued them. Changing which
 * provider is injected (or turning injection off) changes `injectionKey`,
 * which remounts the WebView so the new script takes effect. Navigation,
 * load, error and message events are routed back to the parent via
 * callbacks; the parent updates the tab's `navState` / `currentUrl` in
 * the provider.
 *
 * @module
 */

import {RESPONSE_CALLBACK} from '@pnyx/dapp-connector'
import {forwardRef, useEffect, useImperativeHandle, useRef} from 'react'
import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import type {WebViewMessageEvent, WebViewNavigation, WebView as WebViewType} from 'react-native-webview'
import {WebView} from 'react-native-webview'
import type {WebViewOpenWindowEvent} from 'react-native-webview/lib/WebViewTypes'
import {logger} from '../../logger'
import type {TabNavState} from '../../providers/DappBrowserProvider'

export type TabViewHandle = {
  goBack: () => void
  goForward: () => void
  reload: () => void
  stop: () => void
  postMessage: (message: string) => void
  /** Deliver a CIP-30 `WalletResponse` (JSON string) to the page's bridge callback. */
  deliverResponse: (responseJson: string) => void
}

type TabViewProps = {
  tabId: string
  currentUrl: string | null
  isActive: boolean
  isDarkMode: boolean
  /**
   * CIP-30 provider script injected before page load (per-tab session id).
   * `undefined` installs no provider — dApps then detect no wallet.
   */
  injectedScript?: string | undefined
  /**
   * Bridge message handler — the page posts CIP-30 `DappMessage`s here.
   *
   * `pageUrl` is the WebView's own URL for the frame that posted, taken from the native event
   * rather than from the message body: the injected script runs in the page's context, so any
   * origin it reports is page-authored and a hostile page can post the bridge message itself.
   */
  onDappMessage?: ((raw: string, tabId: string, pageUrl: string) => void) | undefined
  /**
   * Identifies the current injection config. `injectedJavaScriptBeforeContentLoaded`
   * is only consulted while the WebView builds its user scripts, so changing the
   * script in place has no effect on either platform — the WebView is remounted
   * on a new key instead, which reloads the page under the new provider.
   */
  injectionKey: string
  /**
   * Desktop user agent, or `undefined` for the platform default. Part of the injection config, so a
   * change to it must also change {@link TabViewProps.injectionKey} — a WebView reads its user agent
   * once, at mount.
   */
  userAgent?: string | undefined
  onNavigationStateChange: (state: TabNavState) => void
  onUrlChange: (url: string) => void
}

export const TabView = forwardRef<TabViewHandle, TabViewProps>(function TabView(
  {
    tabId,
    currentUrl,
    isActive,
    isDarkMode,
    injectionKey,
    injectedScript,
    userAgent,
    onDappMessage,
    onNavigationStateChange,
    onUrlChange,
  },
  ref,
) {
  const webViewRef = useRef<WebViewType>(null)

  useImperativeHandle(
    ref,
    () => ({
      goBack: () => webViewRef.current?.goBack(),
      goForward: () => webViewRef.current?.goForward(),
      reload: () => webViewRef.current?.reload(),
      stop: () => webViewRef.current?.stopLoading(),
      postMessage: (message: string) => webViewRef.current?.postMessage(message),
      deliverResponse: (responseJson: string) => {
        // Double-encode: JSON.stringify makes `responseJson` a JS string
        // literal the page's callback JSON.parses back to the response object.
        webViewRef.current?.injectJavaScript(`window.${RESPONSE_CALLBACK}(${JSON.stringify(responseJson)}); true;`)
      },
    }),
    [],
  )

  const handleMessage = (event: WebViewMessageEvent) => {
    onDappMessage?.(event.nativeEvent.data, tabId, event.nativeEvent.url)
  }

  const handleNavigationStateChange = (state: WebViewNavigation) => {
    onNavigationStateChange({
      url: state.url,
      title: state.title || '',
      canGoBack: state.canGoBack,
      canGoForward: state.canGoForward,
      loading: state.loading ?? false,
    })
    onUrlChange(state.url)
  }

  const handleContentProcessDidTerminate = () => {
    logger.warn('[DappBrowser] WebView content process terminated, reloading', {tabId})
    webViewRef.current?.reload()
  }

  const handleOpenWindow = (event: WebViewOpenWindowEvent) => {
    const url = event.nativeEvent.targetUrl
    // Allowlist navigable schemes so a dApp can't push `javascript:` / `file:` /
    // `data:` URIs through window.open into the same tab.
    if (!url || !/^(https?|ipfs|ipns):/i.test(url)) return
    webViewRef.current?.injectJavaScript(`window.location.href = ${JSON.stringify(url)}; true;`)
  }

  useEffect(() => {
    if (currentUrl) logger.info('[DappBrowser] Tab navigating', {tabId, url: currentUrl})
  }, [tabId, currentUrl])

  if (!currentUrl) {
    // Tab is on the start page — no WebView mounted yet.
    return null
  }

  return (
    <View
      style={[
        styles.container,
        isActive ? styles.active : styles.inactive,
        {pointerEvents: isActive ? 'auto' : 'none'},
      ]}
    >
      <WebView
        key={injectionKey}
        ref={webViewRef}
        source={{uri: currentUrl}}
        style={styles.webView}
        onNavigationStateChange={handleNavigationStateChange}
        onContentProcessDidTerminate={handleContentProcessDidTerminate}
        onOpenWindow={handleOpenWindow}
        {...(injectedScript ? {injectedJavaScriptBeforeContentLoaded: injectedScript} : {})}
        {...(userAgent !== undefined ? {userAgent} : {})}
        onMessage={handleMessage}
        forceDarkOn={isDarkMode}
        allowsBackForwardNavigationGestures
        javaScriptEnabled
        domStorageEnabled
        startInLoadingState
        originWhitelist={['*']}
        mixedContentMode="compatibility"
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        sharedCookiesEnabled
        thirdPartyCookiesEnabled
      />
    </View>
  )
})

const styles = StyleSheet.create(() => ({
  container: {
    position: 'absolute' as const,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  active: {
    display: 'flex' as const,
  },
  inactive: {
    display: 'none' as const,
  },
  webView: {
    flex: 1,
  },
}))
