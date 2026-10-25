/**
 * DappBrowserScreen.
 *
 * Multi-tab in-app browser. Owns nothing about a single page — everything
 * lives in `DappBrowserProvider`. This screen is the orchestrator: it
 * mounts every tab's WebView (via `TabView`), wires the top bar / start
 * page / overlays / ⋮ menu, and routes CIP-30 events from the dApp
 * connector to the active tab's WebView ref only.
 *
 * @module
 */

import {router, useFocusEffect, useLocalSearchParams} from 'expo-router'
import {useCallback, useEffect, useMemo, useRef, useState} from 'react'
import {BackHandler, Linking, View} from 'react-native'
import {StyleSheet, useUnistyles} from 'react-native-unistyles'
import {discoverDappsFrom} from '../../config/discover-links'
import {useDappConnector} from '../../hooks/useDappConnector'
import {useLatestRef} from '../../hooks/useLatestRef'
import {useToast} from '../../hooks/useToast'
import {logger} from '../../logger'
import {platformIsAndroid} from '../../platform'
import {useDappBrowserState, useI18n, useRemoteConfig} from '../../providers'
import {useCopy} from '../../providers/CopyProvider'
import {desktopSiteInjection} from '../../services/browser-desktop-site'
import {createBrowserHistoryStorage} from '../../services/browser-history-storage'
import {
  MIDNIGHT_IDENTITIES,
  MIDNIGHT_IDENTITY_INJECTION,
  WALLET_IDENTITIES,
  WALLET_IDENTITY_INJECTION,
} from '../../services/browser-prefs-storage'
import {BrowserMenuSheet} from './BrowserMenuSheet'
import {BrowserShareSheet} from './BrowserShareSheet'
import {BrowserStartPage} from './BrowserStartPage'
import {BrowserTopBar} from './BrowserTopBar'
import {DappConnectSheet} from './DappConnectSheet'
import {favouriteForPage, isFavourite} from './dapp-favourites'
import {normalizeUrl} from './normalize-url'
import {SearchEnginePickerSheet} from './SearchEnginePickerSheet'
import {SearchOverlay} from './SearchOverlay'
import {TabsSwitcher} from './TabsSwitcher'
import {TabView, type TabViewHandle} from './TabView'
import {useDappFavourites} from './use-dapp-favourites'
import {WalletIdentityPickerSheet} from './WalletIdentityPickerSheet'

/** Concatenate the before-content-loaded scripts, dropping the absent ones. */
const composeInjection = (...scripts: readonly (string | undefined)[]): string | undefined => {
  const present = scripts.filter((script): script is string => script !== undefined && script.length > 0)
  return present.length === 0 ? undefined : present.join('\n')
}

/**
 * Picker rows, built once from the injection tables so the sheet cannot drift from what is actually
 * installed — the subtitle a user reads is the same array the script iterates.
 */
const CARDANO_IDENTITY_OPTIONS = WALLET_IDENTITIES.map((value) => ({
  value,
  walletName: WALLET_IDENTITY_INJECTION[value].walletName,
  keys: WALLET_IDENTITY_INJECTION[value].providerNames,
}))

const MIDNIGHT_IDENTITY_OPTIONS = MIDNIGHT_IDENTITIES.map((value) => ({
  value,
  walletName: MIDNIGHT_IDENTITY_INJECTION[value].walletName,
  keys: MIDNIGHT_IDENTITY_INJECTION[value].providerKeys,
}))

// Singleton storage instance — `addHistory` / `getHistory` go straight to MMKV,
// so re-creating the wrapper per call is wasteful. The internal in-memory
// session cache is also session-scoped, so a single instance is correct.
const historyStorage = createBrowserHistoryStorage()

export const DappBrowserScreen = () => {
  const {theme} = useUnistyles()
  const {t} = useI18n()
  const browser = useDappBrowserState()
  const {favourites, toggle: toggleFavourite} = useDappFavourites()
  const {dapps} = useRemoteConfig()

  /**
   * What starring the *current page* would save, or `null` on the start page where there is nothing
   * to star. Matched against the curated list first, so starring a dApp here and starring its row
   * are the same act rather than two entries for one dApp.
   */
  const pageFavourite = useMemo(() => {
    const url = browser.activeTab.currentUrl
    if (url === null) return null
    return favouriteForPage({url, title: browser.activeTab.navState.title}, discoverDappsFrom(dapps))
  }, [browser.activeTab.currentUrl, browser.activeTab.navState.title, dapps])
  const {copy} = useCopy()
  const {showToast} = useToast()
  const {url: urlParam, from: fromParam} = useLocalSearchParams<{url?: string; from?: string}>()
  // Latch the Settings-entry intent so `handleClose` can route back via
  // `router.dismissTo('/settings')`. Settings → Browser uses
  // `router.push` (see `app/settings/index.tsx`), so /settings stays on the
  // stack and dismissTo can unwind to it. The latch gates that branch to
  // the Settings entry only — home-rail and `?url=` deep-link entries take
  // the default exit path, where /settings is not on the stack. The
  // `useFocusEffect` below clears it on any re-focus that isn't a fresh
  // `from=settings` entry so a later tab-switch re-entry doesn't inherit a
  // stale intent. Single-use: consumed in `handleClose`.
  const [enteredFromSettings, setEnteredFromSettings] = useState(fromParam === 'settings')
  // The ⋮ menu and the two pickers it leads to. Only one can be open at a
  // time: `Modal` wraps RN's `Modal`, which does not stack reliably on iOS,
  // so the menu closes before a picker opens.
  const [sheet, setSheet] = useState<'menu' | 'searchEngine' | 'walletIdentity' | 'midnightIdentity' | 'share' | null>(
    null,
  )

  const isDark = theme.colors.backgroundDefault === theme.colors.black

  // Per-tab WebView handles. Map keyed by tab id; cleared in TabView's unmount path.
  const tabHandlesRef = useRef(new Map<string, TabViewHandle | null>())
  const setTabHandle = useCallback(
    (tabId: string) => (handle: TabViewHandle | null) => {
      if (handle === null) tabHandlesRef.current.delete(tabId)
      else tabHandlesRef.current.set(tabId, handle)
    },
    [],
  )

  // CIP-30 dApp connector: deliver responses to the originating tab's WebView.
  const deliverResponse = useCallback((tabId: string, responseJson: string) => {
    tabHandlesRef.current.get(tabId)?.deliverResponse(responseJson)
  }, [])
  const dapp = useDappConnector(deliverResponse)

  // Seed the active tab's URL from the deep-link `url` search param (e.g. QR code launch).
  // Clear the param after consumption so a subsequent navigation with the same URL re-fires.
  useEffect(() => {
    if (typeof urlParam === 'string' && urlParam.length > 0) {
      const normalized = normalizeUrl(urlParam, browser.searchEngine)
      if (normalized) {
        browser.setTabInputUrl(browser.activeTabId, normalized)
        browser.setTabCurrentUrl(browser.activeTabId, normalized)
      }
      router.setParams({url: undefined})
    }
  }, [urlParam, browser.activeTabId, browser.searchEngine, browser.setTabInputUrl, browser.setTabCurrentUrl])

  /**
   * Latch the settings-entry intent and strip the `from` param after consumption.
   *
   * ⚠️ **It no longer resets the active tab.** Entering from Settings used to clear the tab's URL so
   * the discover list always showed — which meant the tab you were last on *died* every time you
   * came back that way, while every other tab survived. Jordi, seeing it: *"When going back the
   * current tab dies, and only the others survive."*
   *
   * A tab should outlive leaving the browser. Losing a page is what in-page back and closing the
   * tab in the switcher are for; arriving from one menu rather than another is not a reason. The
   * home-rail entry always resumed, so this also makes the two entry points agree.
   *
   * The latch itself stays: it is what sends `handleClose` back to `/menu` rather than unwinding
   * the stack.
   */
  useEffect(() => {
    if (fromParam === 'settings') setEnteredFromSettings(true)
    if (fromParam) router.setParams({from: undefined})
  }, [fromParam])

  // Reset the latch on any re-focus that isn't itself a `from=settings`
  // entry. The component stays mounted while /browser sits on the stack,
  // so a later rail / deep-link re-entry shouldn't inherit a stale
  // "came from settings" intent. `fromParam` is read via a ref so the
  // focus callback's identity stays stable across renders — without that
  // the param-strip above (which sets `fromParam` to `undefined`) would
  // flip the callback identity and `useFocusEffect` would re-run while
  // still on the initial focus, clearing the latch before `handleClose`
  // can consume it. (Cursor Bot finding on PR #2129.)
  const fromParamRef = useLatestRef(fromParam)
  useFocusEffect(
    useCallback(() => {
      if (fromParamRef.current !== 'settings') setEnteredFromSettings(false)
    }, []),
  )

  const loadUrlInActiveTab = useCallback(
    (rawUrl: string) => {
      const normalized = normalizeUrl(rawUrl, browser.searchEngine)
      if (!normalized) return
      browser.setTabInputUrl(browser.activeTabId, normalized)
      browser.setTabCurrentUrl(browser.activeTabId, normalized)
      historyStorage.addHistory({url: normalized, visitedAt: Date.now()}).catch((e) => {
        logger.warn('Failed to record browser history', {origin: 'DappBrowserScreen', error: String(e)})
      })
    },
    [browser],
  )

  const handleSearchSubmit = useCallback(
    (raw: string) => {
      loadUrlInActiveTab(raw)
      browser.closeSearchOverlay()
    },
    [browser, loadUrlInActiveTab],
  )

  const handlePickDiscoverLink = useCallback(
    (url: string) => {
      loadUrlInActiveTab(url)
    },
    [loadUrlInActiveTab],
  )

  // Look up the active handle on each call rather than memoising — refs change
  // outside React's render cycle, so a memoised handle could go stale.
  const handleReload = useCallback(
    () => tabHandlesRef.current.get(browser.activeTabId)?.reload(),
    [browser.activeTabId],
  )
  const handleStop = useCallback(() => tabHandlesRef.current.get(browser.activeTabId)?.stop(), [browser.activeTabId])
  /**
   * In-page back: walk the WebView's history, and when it runs out, return to the start page.
   *
   * ⚠️ **The start page is not in the WebView's history.** A tab begins blank and the WebView is only
   * created once there is a URL, so opening a dApp from the discover list leaves `canGoBack` false —
   * back looked disabled on the very first page, with the start page one step away and no way to
   * reach it. Since the top-bar arrow now leaves the browser entirely, this is the only route back
   * to the list.
   */
  /**
   * Drop the tab's page so the start page renders in its place. The tab itself survives, which is
   * what separates this from `closeTab`: the user is going back to the list, not disposing of a tab.
   */
  const goToStartPage = useCallback(() => {
    browser.setTabCurrentUrl(browser.activeTabId, null)
    browser.setTabInputUrl(browser.activeTabId, '')
  }, [browser.activeTabId, browser.setTabCurrentUrl, browser.setTabInputUrl])

  const handlePageBack = useCallback(() => {
    const handle = tabHandlesRef.current.get(browser.activeTabId)
    if (handle && browser.activeTab.navState.canGoBack) {
      handle.goBack()
      return
    }
    goToStartPage()
  }, [browser.activeTabId, browser.activeTab.navState.canGoBack, goToStartPage])
  const handlePageForward = useCallback(
    () => tabHandlesRef.current.get(browser.activeTabId)?.goForward(),
    [browser.activeTabId],
  )

  const handleClose = useCallback(() => {
    // Exit Browser surface. Tabs are session-only — they remain in memory
    // until the user kills the app. Coming back to /browser will
    // restore them.
    //
    // When entered from /settings, unwind directly to it via
    // `router.dismissTo` — Settings → Browser uses `router.push`, so the
    // /settings frame is still on the stack. dismissTo is preferred over a
    // bare `router.back()` because it's robust against intermediate pushes
    // (e.g. a side trip into a review screen) and expresses the intent
    // explicitly. Latch is single-use: cleared here so a subsequent close
    // from a different entry path (home rail, deep link) takes the default
    // exit below.
    if (enteredFromSettings) {
      setEnteredFromSettings(false)
      router.dismissTo('/menu')
      return
    }
    if (router.canGoBack()) router.back()
    else router.replace('/community')
  }, [enteredFromSettings])

  /**
   * Top-bar back arrow: leaves the Browser, always.
   *
   * ⚠️ **Deliberately not in-page history.** It used to walk the WebView back stack first, which is
   * what a standalone browser does — but this arrow is the app's back arrow, in the app's header,
   * and it is the only way out of the surface. Deep inside a dApp's own history it stopped being an
   * exit and became indistinguishable from the page's own navigation, with no way to tell how many
   * taps were left. In-page back has its own affordance in the bottom sheet, next to forward and
   * reload, where it reads as page navigation rather than app navigation.
   *
   * The Android hardware key still walks history first — that is the platform's convention and not
   * ours to override.
   */
  const handleTopBarBack = useCallback(() => {
    handleClose()
  }, [handleClose])

  // Android hardware back: dismiss whatever overlay is on top first, then walk
  // in-page history when the WebView has any, and only then exit the Browser
  // surface.
  useEffect(() => {
    if (!platformIsAndroid) return undefined
    const onHardwareBack = (): boolean => {
      if (sheet !== null) {
        setSheet(null)
        return true
      }
      if (browser.isSwitcherOpen) {
        browser.closeSwitcher()
        return true
      }
      if (browser.isSearchOverlayOpen) {
        browser.closeSearchOverlay()
        return true
      }
      const handle = tabHandlesRef.current.get(browser.activeTabId)
      if (handle && browser.activeTab.navState.canGoBack) {
        handle.goBack()
        return true
      }
      handleClose()
      return true
    }
    const sub = BackHandler.addEventListener('hardwareBackPress', onHardwareBack)
    return () => sub.remove()
  }, [
    sheet,
    browser.isSwitcherOpen,
    browser.isSearchOverlayOpen,
    browser.activeTabId,
    browser.activeTab.navState.canGoBack,
    browser.closeSwitcher,
    browser.closeSearchOverlay,
    handleClose,
  ])

  const handleLongPressUrl = useCallback(() => {
    const url = browser.activeTab.currentUrl ?? browser.activeTab.inputUrl
    if (!url) return
    copy({text: url}).catch((e) => {
      logger.warn('Failed to copy the URL bar contents', {origin: 'DappBrowserScreen', error: String(e)})
    })
  }, [browser.activeTab.currentUrl, browser.activeTab.inputUrl, copy])

  /** Menu "Copy link" — the same clipboard write as long-pressing the URL bar, from the sheet. */
  const handleCopyUrl = useCallback(() => {
    const url = browser.activeTab.currentUrl
    if (url === null) return
    setSheet(null)
    copy({text: url}).catch((e) => {
      logger.warn('Failed to copy the page link', {origin: 'DappBrowserScreen', error: String(e)})
    })
  }, [browser.activeTab.currentUrl, copy])

  /**
   * Hand the page to the OS browser. `canOpenURL` first so a scheme nothing on the device handles
   * reports as such instead of failing silently — the user is being sent away, and a no-op looks
   * like a broken button.
   */
  const handleOpenExternally = useCallback(() => {
    const url = browser.activeTab.currentUrl
    if (url === null) return
    setSheet(null)
    void Linking.canOpenURL(url)
      .then((supported) => (supported ? Linking.openURL(url) : Promise.reject(new Error('unsupported'))))
      .catch((e) => {
        // The toast tells the user; the log tells us which URL the platform refused.
        logger.warn('Cannot open the page externally', {origin: 'DappBrowserScreen', error: String(e)})
        showToast({variant: 'error', message: t('browser.share.cannotOpen')})
      })
  }, [browser.activeTab.currentUrl, showToast, t])

  const tabs = useMemo(() => browser.tabs, [browser.tabs])

  // Identifies the active injection config. Changing it remounts every tab's
  // WebView, which is what makes a new provider (or none) take effect —
  // `injectedJavaScriptBeforeContentLoaded` is only read while the WebView
  // builds its user scripts, so a plain reload would keep the old provider.
  // Desktop mode is part of that config too: the user agent is read once at mount, and the viewport
  // script rides the same before-content-loaded slot.
  const desktop = desktopSiteInjection(browser.desktopSite)
  // Every switch that changes the injected script belongs in this key, or a toggle leaves the old
  // provider in the page: the script is only read while the WebView builds its user scripts.
  const injectionKey = [
    browser.cardanoInjectionEnabled ? `cardano:${browser.walletIdentity}` : 'no-cardano',
    browser.midnightInjectionEnabled ? `midnight:${browser.midnightIdentity}` : 'no-midnight',
    browser.desktopSite ? 'desktop' : 'mobile',
  ].join('|')

  return (
    <View style={styles.container}>
      <BrowserTopBar
        inputUrl={browser.activeTab.inputUrl}
        currentUrl={browser.activeTab.currentUrl}
        navState={browser.activeTab.navState}
        tabCount={tabs.length}
        onBack={handleTopBarBack}
        onClosePage={goToStartPage}
        onUrlPress={browser.openSearchOverlay}
        onUrlLongPress={handleLongPressUrl}
        onOpenTabs={browser.openSwitcher}
        onOpenMenu={() => setSheet('menu')}
        onRefresh={handleReload}
        onStop={handleStop}
      />

      <View style={styles.body}>
        {browser.activeTab.currentUrl === null && (
          <BrowserStartPage
            onPickLink={handlePickDiscoverLink}
            favourites={favourites}
            onToggleFavourite={toggleFavourite}
          />
        )}
        {tabs.map((tab) => (
          <TabView
            key={tab.id}
            ref={setTabHandle(tab.id)}
            tabId={tab.id}
            currentUrl={tab.currentUrl}
            isActive={tab.id === browser.activeTabId}
            isDarkMode={isDark}
            injectionKey={injectionKey}
            // Viewport first, so the layout width is set before the page — or the provider — runs.
            injectedScript={composeInjection(
              desktop.script,
              // Built whenever *either* provider is wanted; each registry is then installed or not
              // inside the script. Gating the whole script on Cardano alone would have made the
              // Midnight switch do nothing whenever Cardano was off.
              browser.cardanoInjectionEnabled || browser.midnightInjectionEnabled
                ? dapp.getInjectedScript(tab.id, browser.walletIdentity, browser.midnightIdentity, {
                    cardano: browser.cardanoInjectionEnabled,
                    midnight: browser.midnightInjectionEnabled,
                  })
                : undefined,
            )}
            {...(desktop.userAgent !== undefined ? {userAgent: desktop.userAgent} : {})}
            onDappMessage={dapp.onDappMessage}
            onNavigationStateChange={(navState) => browser.setTabNavState(tab.id, navState)}
            onUrlChange={(url) => browser.setTabInputUrl(tab.id, url)}
          />
        ))}
      </View>

      <DappConnectSheet request={dapp.pendingRequest} onApprove={dapp.approve} onReject={dapp.reject} />

      <BrowserMenuSheet
        visible={sheet === 'menu'}
        navState={browser.activeTab.currentUrl === null ? null : browser.activeTab.navState}
        onNewTab={() => {
          // Same act as the switcher's `+`, without the detour through it: make the tab, then get
          // out of the way so the new tab's start page is what you land on.
          browser.createTab()
          setSheet(null)
        }}
        isPageFavourite={pageFavourite === null ? null : isFavourite(favourites, pageFavourite.id)}
        onTogglePageFavourite={() => {
          if (pageFavourite !== null) toggleFavourite(pageFavourite)
        }}
        searchEngineLabel={t(`browser.searchEngines.${browser.searchEngine}`)}
        walletIdentityLabel={WALLET_IDENTITY_INJECTION[browser.walletIdentity].walletName}
        midnightIdentityLabel={MIDNIGHT_IDENTITY_INJECTION[browser.midnightIdentity].walletName}
        cardanoInjectionEnabled={browser.cardanoInjectionEnabled}
        midnightInjectionEnabled={browser.midnightInjectionEnabled}
        desktopSite={browser.desktopSite}
        onClose={() => setSheet(null)}
        onGoBack={() => {
          setSheet(null)
          handlePageBack()
        }}
        onGoForward={() => {
          setSheet(null)
          handlePageForward()
        }}
        onReload={() => {
          setSheet(null)
          handleReload()
        }}
        onStop={() => {
          setSheet(null)
          handleStop()
        }}
        onShare={() => setSheet('share')}
        onCopyUrl={handleCopyUrl}
        onOpenExternally={handleOpenExternally}
        onOpenSearchEnginePicker={() => setSheet('searchEngine')}
        onOpenWalletIdentityPicker={() => setSheet('walletIdentity')}
        onOpenMidnightIdentityPicker={() => setSheet('midnightIdentity')}
        onToggleCardanoInjection={browser.setCardanoInjectionEnabled}
        onToggleMidnightInjection={browser.setMidnightInjectionEnabled}
        onToggleDesktopSite={browser.setDesktopSite}
      />

      <BrowserShareSheet
        visible={sheet === 'share'}
        url={browser.activeTab.currentUrl}
        onClose={() => setSheet(null)}
      />

      <SearchEnginePickerSheet
        visible={sheet === 'searchEngine'}
        selected={browser.searchEngine}
        onSelect={(engine) => {
          browser.setSearchEngine(engine)
          setSheet(null)
        }}
        onClose={() => setSheet(null)}
      />

      <WalletIdentityPickerSheet
        visible={sheet === 'walletIdentity'}
        selected={browser.walletIdentity}
        options={CARDANO_IDENTITY_OPTIONS}
        registry="window.cardano"
        title={t('browser.settings.showAs')}
        description={t('browser.settings.showAsSubtitle')}
        testIDPrefix="browser-wallet-identity"
        onSelect={(identity) => {
          browser.setWalletIdentity(identity)
          setSheet(null)
        }}
        onClose={() => setSheet(null)}
      />

      <WalletIdentityPickerSheet
        visible={sheet === 'midnightIdentity'}
        selected={browser.midnightIdentity}
        options={MIDNIGHT_IDENTITY_OPTIONS}
        registry="window.midnight"
        title={t('browser.settings.showAsMidnight')}
        description={t('browser.settings.showAsMidnightSubtitle')}
        testIDPrefix="browser-midnight-identity"
        onSelect={(identity) => {
          browser.setMidnightIdentity(identity)
          setSheet(null)
        }}
        onClose={() => setSheet(null)}
      />

      <SearchOverlay
        visible={browser.isSearchOverlayOpen}
        initialUrl={browser.activeTab.inputUrl}
        searchEngine={browser.searchEngine}
        historyStorage={historyStorage}
        onSubmit={handleSearchSubmit}
        onClose={browser.closeSearchOverlay}
      />

      <TabsSwitcher
        visible={browser.isSwitcherOpen}
        tabs={browser.tabs}
        activeTabId={browser.activeTabId}
        onSelect={(id) => {
          browser.switchTab(id)
          browser.closeSwitcher()
        }}
        onClose={(id) => browser.closeTab(id)}
        onNewTab={() => {
          browser.createTab()
          browser.closeSwitcher()
        }}
        onDismiss={browser.closeSwitcher}
      />
    </View>
  )
}

const styles = StyleSheet.create(({colors}) => ({
  container: {
    flex: 1,
    backgroundColor: colors.backgroundDefault,
  },
  body: {
    flex: 1,
    position: 'relative' as const,
  },
}))
