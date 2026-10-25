/**
 * DappBrowser state provider.
 *
 * Owns the multi-tab session model (tabs list, active tab, switcher and
 * search overlay open/close) plus the `isInDapp` flag the browser route
 * uses to extend through the bottom inset while a WebView is in the
 * foreground.
 *
 * Tabs are session-only — they reset on app kill. WebView refs live
 * outside this provider (in the browser screen) since refs don't fit
 * cleanly in React state.
 *
 * @module
 */

import {createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState} from 'react'

import {logger} from '../logger'
import {
  type BrowserMidnightIdentity,
  type BrowserSearchEngine,
  type BrowserWalletIdentity,
  readBrowserPrefs,
  readBrowserPrefsSync,
  writeCardanoInjectionEnabled,
  writeDesktopSite,
  writeMidnightIdentity,
  writeMidnightInjectionEnabled,
  writeSearchEngine,
  writeWalletIdentity,
} from '../services/browser-prefs-storage'

/** Per-tab navigation state mirrored from `react-native-webview`'s `WebViewNavigation`. */
export type TabNavState = {
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
}

const DEFAULT_NAV_STATE: TabNavState = {
  url: '',
  title: '',
  canGoBack: false,
  canGoForward: false,
  loading: false,
}

/** A single browser tab. `currentUrl === null` means the tab is on the start page. */
export type BrowserTab = {
  /** Stable id used as a key everywhere (refs, snapshots, switcher list). */
  id: string
  /** Text currently in the URL pill (may differ from currentUrl while user is editing). */
  inputUrl: string
  /** Loaded URL or `null` when on the start page. */
  currentUrl: string | null
  /** Most recent navigation state from the WebView. */
  navState: TabNavState
  /** Captured WebView snapshot URI used as the tab card thumbnail; `null` until first capture. */
  thumbnailUri: string | null
}

type DappBrowserContextValue = {
  /** Whether the user is currently inside a dApp (any tab has a URL loaded). */
  isInDapp: boolean

  /** Open tabs in stable creation order. Always at least one tab exists. */
  tabs: readonly BrowserTab[]
  /** Id of the tab currently shown in the foreground. */
  activeTabId: string
  /** The active tab object, derived from `tabs` + `activeTabId`. */
  activeTab: BrowserTab

  /** Create a new tab and make it active. Returns the new tab's id. */
  createTab: (initialUrl?: string) => string
  /** Close a tab. If it was the last tab, a fresh start-page tab is created in its place. */
  closeTab: (id: string) => void
  /** Switch which tab is active. */
  switchTab: (id: string) => void

  /** Update the URL pill text for a tab (does not navigate). */
  setTabInputUrl: (id: string, inputUrl: string) => void
  /** Set the loaded URL for a tab. `null` returns the tab to the start page. */
  setTabCurrentUrl: (id: string, url: string | null) => void
  /** Patch navigation state for a tab. */
  setTabNavState: (id: string, navState: TabNavState) => void
  /** Store a captured thumbnail URI for the tab. */
  setTabThumbnail: (id: string, uri: string | null) => void

  /** Tabs switcher overlay state. */
  isSwitcherOpen: boolean
  openSwitcher: () => void
  closeSwitcher: () => void

  /** Full-screen search overlay state. */
  isSearchOverlayOpen: boolean
  openSearchOverlay: () => void
  closeSearchOverlay: () => void

  /** Persisted browser preferences. */
  searchEngine: BrowserSearchEngine
  walletIdentity: BrowserWalletIdentity
  midnightIdentity: BrowserMidnightIdentity
  /** When false, no CIP-30 provider is installed and dApps see no wallet. */
  cardanoInjectionEnabled: boolean
  /** Request pages as a desktop browser would — desktop UA plus a wide layout viewport. */
  desktopSite: boolean
  setSearchEngine: (engine: BrowserSearchEngine) => void
  setWalletIdentity: (identity: BrowserWalletIdentity) => void
  setMidnightIdentity: (identity: BrowserMidnightIdentity) => void
  setCardanoInjectionEnabled: (enabled: boolean) => void
  midnightInjectionEnabled: boolean
  setMidnightInjectionEnabled: (enabled: boolean) => void
  setDesktopSite: (enabled: boolean) => void
}

const DappBrowserContext = createContext<DappBrowserContextValue | null>(null)

export type DappBrowserProviderProps = {
  children: ReactNode
}

let nextTabId = 1
const makeTabId = () => `tab-${nextTabId++}`

const makeStartTab = (initialUrl?: string): BrowserTab => ({
  id: makeTabId(),
  inputUrl: initialUrl ?? '',
  currentUrl: initialUrl ?? null,
  navState: DEFAULT_NAV_STATE,
  thumbnailUri: null,
})

export function DappBrowserProvider({children}: DappBrowserProviderProps) {
  const [tabs, setTabs] = useState<readonly BrowserTab[]>(() => [makeStartTab()])
  const [activeTabId, setActiveTabId] = useState<string>(() => (tabs[0] as BrowserTab).id)
  const [isSwitcherOpen, setIsSwitcherOpen] = useState(false)
  const [isSearchOverlayOpen, setIsSearchOverlayOpen] = useState(false)

  // Seed prefs from sync storage where available (mobile / web). Extension's
  // chrome.storage is async-only, so the sync read returns defaults and we
  // hydrate from `readBrowserPrefs()` after mount.
  const initialPrefs = useMemo(() => readBrowserPrefsSync(), [])
  const [searchEngine, setSearchEngineState] = useState<BrowserSearchEngine>(initialPrefs.searchEngine)
  const [walletIdentity, setWalletIdentityState] = useState<BrowserWalletIdentity>(initialPrefs.walletIdentity)
  const [midnightIdentity, setMidnightIdentityState] = useState<BrowserMidnightIdentity>(initialPrefs.midnightIdentity)
  const [cardanoInjectionEnabled, setCardanoInjectionEnabledState] = useState<boolean>(
    initialPrefs.cardanoInjectionEnabled,
  )
  const [midnightInjectionEnabled, setMidnightInjectionEnabledState] = useState<boolean>(
    initialPrefs.midnightInjectionEnabled,
  )
  const [desktopSite, setDesktopSiteState] = useState<boolean>(initialPrefs.desktopSite)

  useEffect(() => {
    let cancelled = false
    readBrowserPrefs()
      .then((prefs) => {
        if (cancelled) return
        setSearchEngineState((prev) => (prev === prefs.searchEngine ? prev : prefs.searchEngine))
        setWalletIdentityState((prev) => (prev === prefs.walletIdentity ? prev : prefs.walletIdentity))
        setMidnightIdentityState((prev) => (prev === prefs.midnightIdentity ? prev : prefs.midnightIdentity))
        setCardanoInjectionEnabledState((prev) =>
          prev === prefs.cardanoInjectionEnabled ? prev : prefs.cardanoInjectionEnabled,
        )
        setMidnightInjectionEnabledState((prev) =>
          prev === prefs.midnightInjectionEnabled ? prev : prefs.midnightInjectionEnabled,
        )
        setDesktopSiteState((prev) => (prev === prefs.desktopSite ? prev : prefs.desktopSite))
      })
      .catch((e) => {
        logger.warn('Browser prefs hydration failed; keeping the sync-read values', {
          origin: 'DappBrowserProvider',
          error: String(e),
        })
      })
    return () => {
      cancelled = true
    }
  }, [])

  const activeTab = useMemo(
    () => tabs.find((t) => t.id === activeTabId) ?? (tabs[0] as BrowserTab),
    [tabs, activeTabId],
  )

  // `isInDapp` is true when *any* tab has a URL loaded — the browser surface
  // goes immersive as soon as we're inside any WebView, regardless of which
  // tab is foregrounded.
  const isInDapp = useMemo(() => tabs.some((t) => t.currentUrl !== null), [tabs])

  const createTab = useCallback((initialUrl?: string) => {
    const tab = makeStartTab(initialUrl)
    setTabs((prev) => [...prev, tab])
    setActiveTabId(tab.id)
    return tab.id
  }, [])

  const closeTab = useCallback(
    (id: string) => {
      setTabs((prev) => {
        const filtered = prev.filter((t) => t.id !== id)
        if (filtered.length === 0) {
          const fresh = makeStartTab()
          setActiveTabId(fresh.id)
          return [fresh]
        }
        return filtered
      })
      setActiveTabId((current) => {
        if (current !== id) return current
        // Closing the active tab — fall back to the last-remaining tab in the post-filter list.
        const next = (tabs.find((t) => t.id !== id) ?? tabs[0]) as BrowserTab
        return next.id
      })
    },
    [tabs],
  )

  const switchTab = useCallback((id: string) => {
    setActiveTabId(id)
  }, [])

  const patchTab = useCallback((id: string, patch: Partial<BrowserTab>) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? {...t, ...patch} : t)))
  }, [])

  const setTabInputUrl = useCallback((id: string, inputUrl: string) => patchTab(id, {inputUrl}), [patchTab])
  const setTabCurrentUrl = useCallback((id: string, url: string | null) => patchTab(id, {currentUrl: url}), [patchTab])
  const setTabNavState = useCallback((id: string, navState: TabNavState) => patchTab(id, {navState}), [patchTab])
  const setTabThumbnail = useCallback((id: string, uri: string | null) => patchTab(id, {thumbnailUri: uri}), [patchTab])

  const openSwitcher = useCallback(() => setIsSwitcherOpen(true), [])
  const closeSwitcher = useCallback(() => setIsSwitcherOpen(false), [])
  const openSearchOverlay = useCallback(() => setIsSearchOverlayOpen(true), [])
  const closeSearchOverlay = useCallback(() => setIsSearchOverlayOpen(false), [])

  const setSearchEngine = useCallback((engine: BrowserSearchEngine) => {
    setSearchEngineState(engine)
    void writeSearchEngine(engine)
  }, [])

  const setWalletIdentity = useCallback((identity: BrowserWalletIdentity) => {
    setWalletIdentityState(identity)
    void writeWalletIdentity(identity)
  }, [])

  const setMidnightIdentity = useCallback((identity: BrowserMidnightIdentity) => {
    setMidnightIdentityState(identity)
    void writeMidnightIdentity(identity)
  }, [])

  const setCardanoInjectionEnabled = useCallback((enabled: boolean) => {
    setCardanoInjectionEnabledState(enabled)
    void writeCardanoInjectionEnabled(enabled)
  }, [])

  const setMidnightInjectionEnabled = useCallback((enabled: boolean) => {
    setMidnightInjectionEnabledState(enabled)
    void writeMidnightInjectionEnabled(enabled)
  }, [])

  const setDesktopSite = useCallback((enabled: boolean) => {
    setDesktopSiteState(enabled)
    void writeDesktopSite(enabled)
  }, [])

  const value = useMemo<DappBrowserContextValue>(
    () => ({
      isInDapp,
      tabs,
      activeTabId,
      activeTab,
      createTab,
      closeTab,
      switchTab,
      setTabInputUrl,
      setTabCurrentUrl,
      setTabNavState,
      setTabThumbnail,
      isSwitcherOpen,
      openSwitcher,
      closeSwitcher,
      isSearchOverlayOpen,
      openSearchOverlay,
      closeSearchOverlay,
      searchEngine,
      walletIdentity,
      midnightIdentity,
      cardanoInjectionEnabled,
      midnightInjectionEnabled,
      desktopSite,
      setSearchEngine,
      setWalletIdentity,
      setMidnightIdentity,
      setCardanoInjectionEnabled,
      setMidnightInjectionEnabled,
      setDesktopSite,
    }),
    [
      isInDapp,
      tabs,
      activeTabId,
      activeTab,
      createTab,
      closeTab,
      switchTab,
      setTabInputUrl,
      setTabCurrentUrl,
      setTabNavState,
      setTabThumbnail,
      isSwitcherOpen,
      openSwitcher,
      closeSwitcher,
      isSearchOverlayOpen,
      openSearchOverlay,
      closeSearchOverlay,
      searchEngine,
      walletIdentity,
      midnightIdentity,
      cardanoInjectionEnabled,
      midnightInjectionEnabled,
      desktopSite,
      setSearchEngine,
      setWalletIdentity,
      setMidnightIdentity,
      setCardanoInjectionEnabled,
      setMidnightInjectionEnabled,
      setDesktopSite,
    ],
  )

  return <DappBrowserContext.Provider value={value}>{children}</DappBrowserContext.Provider>
}

export function useDappBrowserState(): DappBrowserContextValue {
  const context = useContext(DappBrowserContext)
  if (!context) {
    throw new Error('useDappBrowserState must be used within a DappBrowserProvider')
  }
  return context
}
