/**
 * Browser preferences storage.
 *
 * Persists the user's choices for the in-app browser menu sheet:
 *   - default search engine
 *   - injected wallet identity ('pnyx' | 'eternl' | 'lace')
 *   - whether the CIP-30 provider is injected at all
 *   - whether pages are requested as a desktop site
 *
 * Backed by `platform/storage` (MMKV on mobile, localStorage on web).
 *
 * @module
 */

import {logger} from '../logger'
import {storage} from '../platform/storage'

/** Search engines we know how to redirect through `buildSearchUrl`. */
export type BrowserSearchEngine =
  | 'google'
  | 'duckduckgo'
  | 'brave'
  | 'ecosia'
  | 'startpage'
  | 'bing'
  | 'yahooJapan'
  | 'naver'
  | 'baidu'
  | 'yandex'

/** Wallet identity injected into `window.cardano.<name>` for dApp discovery. */
export type BrowserWalletIdentity = 'pnyx' | 'eternl' | 'lace'

/**
 * Wallet identity the Midnight provider reports, for dApps that look for a specific wallet.
 *
 * Separate from {@link BrowserWalletIdentity} because the two registries are matched on different
 * things and the wallets are different products: Eternl has no Midnight provider, and Lace's
 * Midnight key (`mnLace`) is not its Cardano one (`lace`).
 */
export type BrowserMidnightIdentity = 'pnyx' | 'lace' | '1am'

export type BrowserPrefs = {
  readonly searchEngine: BrowserSearchEngine
  readonly walletIdentity: BrowserWalletIdentity
  /** Which wallet the injected `window.midnight` provider claims to be. */
  readonly midnightIdentity: BrowserMidnightIdentity
  readonly cardanoInjectionEnabled: boolean
  /**
   * Whether `window.midnight` is installed for pages to find.
   *
   * Its own switch rather than one "inject wallets" flag: a user may want one chain's dApps to see this
   * wallet and not the other's, and the two providers are independent surfaces.
   */
  readonly midnightInjectionEnabled: boolean
  /**
   * Request pages as a desktop browser would: a desktop user agent *and* a wide layout viewport.
   * Plenty of dApps gate on CSS width alone, which a user-agent switch does not move — see
   * `DESKTOP_VIEWPORT_SCRIPT`.
   */
  readonly desktopSite: boolean
}

const SEARCH_ENGINE_KEY = 'browser:searchEngine'
const WALLET_IDENTITY_KEY = 'browser:walletIdentity'
const CARDANO_INJECTION_KEY = 'browser:cardanoInjection'
const MIDNIGHT_IDENTITY_KEY = 'browser:midnightIdentity'
const MIDNIGHT_INJECTION_KEY = 'browser:midnightInjection'
const DESKTOP_SITE_KEY = 'browser:desktopSite'

const DEFAULT_PREFS: BrowserPrefs = {
  searchEngine: 'google',
  walletIdentity: 'pnyx',
  midnightIdentity: 'pnyx',
  cardanoInjectionEnabled: true,
  midnightInjectionEnabled: true,
  desktopSite: false,
}

/**
 * Ordered list of selectable search engines. The order here drives the
 * order rendered in the menu picker — Google first as the default,
 * privacy-leaning engines next, then mainstream + regional.
 */
export const SEARCH_ENGINES: readonly BrowserSearchEngine[] = [
  'google',
  'duckduckgo',
  'brave',
  'ecosia',
  'startpage',
  'bing',
  'yahooJapan',
  'naver',
  'baidu',
  'yandex',
]

/**
 * Ordered list of selectable wallet identities — drives the picker order.
 * Pnyx first (the honest identity); the rest are impersonation options for
 * dApps that gate on a specific `window.cardano` key.
 */
export const WALLET_IDENTITIES: readonly BrowserWalletIdentity[] = ['pnyx', 'eternl', 'lace']

/**
 * What each identity injects: the `name` the CIP-30 provider reports and the
 * `window.cardano.<key>` slots it installs itself under. The key is what dApps
 * feature-detect on, so it is the part that actually decides whether a wallet
 * is discovered — the name only shows in the dApp's own connect UI.
 */
export const WALLET_IDENTITY_INJECTION: Record<
  BrowserWalletIdentity,
  {readonly walletName: string; readonly providerNames: readonly string[]}
> = {
  pnyx: {walletName: 'Pnyx', providerNames: ['pnyx']},
  eternl: {walletName: 'Eternl', providerNames: ['eternl']},
  lace: {walletName: 'Lace', providerNames: ['lace']},
}

/** Ordered list of selectable Midnight identities — drives the picker order. */
export const MIDNIGHT_IDENTITIES: readonly BrowserMidnightIdentity[] = ['pnyx', 'lace', '1am']

/**
 * What each Midnight identity reports.
 *
 * ⚠️ **`walletName` is the load-bearing field, not `rdns`.** The spec keys the registry by UUID and
 * offers `rdns` for discovery, but real dApps do not read it. Measured against Ascend's shipped
 * bundle (`dex.ascend.market`, 2026-09-21), which enumerates the registry and matches on the
 * **key and the name together**:
 *
 * ```js
 * Object.entries(window.midnight).filter(([, p]) => typeof p.connect === 'function')
 * const hit = s => entries.find(([key, p]) => `${key} ${p.name ?? ''}`.toLowerCase().includes(s))
 * hit('lace') ?? hit('1am') ?? hit('1 am') ?? entries[0]
 * ```
 *
 * `rdns` appears **zero times** in that bundle. So the name alone satisfies it, and `providerKeys`
 * is the second chance for dApps that instead hardcode `window.midnight.mnLace` / `['1am']` — the
 * pattern the Midnight tutorials use. Both are set, because the two styles are both in the wild.
 *
 * `rdns` is still carried for spec-compliant consumers, and is the one field kept honest: it names
 * the software that is actually answering.
 */
export const MIDNIGHT_IDENTITY_INJECTION: Record<
  BrowserMidnightIdentity,
  {readonly walletName: string; readonly providerKeys: readonly string[]}
> = {
  pnyx: {walletName: 'Pnyx', providerKeys: ['pnyx']},
  // `mnLace` is the key Lace ships and the tutorials hardcode; `lace` is carried too because some
  // dApps use the shorter spelling, and an extra registry entry costs nothing.
  lace: {walletName: 'Lace', providerKeys: ['mnLace', 'lace']},
  '1am': {walletName: '1AM', providerKeys: ['1am']},
}

/**
 * Search URL templates per engine. `{q}` is replaced with the URL-encoded query.
 * Patterns mirror each engine's actual public search endpoint — verified against
 * the engines' own search forms; do not refactor to a single template without
 * checking each one (Naver / Baidu / Yahoo Japan use different param names).
 */
const SEARCH_URL_TEMPLATES: Record<BrowserSearchEngine, string> = {
  google: 'https://www.google.com/search?q={q}',
  duckduckgo: 'https://duckduckgo.com/?q={q}',
  brave: 'https://search.brave.com/search?q={q}',
  ecosia: 'https://www.ecosia.org/search?q={q}',
  startpage: 'https://www.startpage.com/do/search?query={q}',
  bing: 'https://www.bing.com/search?q={q}',
  yahooJapan: 'https://search.yahoo.co.jp/search?p={q}',
  naver: 'https://search.naver.com/search.naver?query={q}',
  baidu: 'https://www.baidu.com/s?wd={q}',
  yandex: 'https://yandex.com/search/?text={q}',
}

/** Build a search URL for the given engine with the user's raw query. */
export const buildSearchUrl = (engine: BrowserSearchEngine, query: string): string =>
  SEARCH_URL_TEMPLATES[engine].replace('{q}', encodeURIComponent(query))

const isEngine = (raw: string | null): raw is BrowserSearchEngine =>
  raw !== null && (SEARCH_ENGINES as readonly string[]).includes(raw)

const isIdentity = (raw: string | null): raw is BrowserWalletIdentity =>
  raw !== null && (WALLET_IDENTITIES as readonly string[]).includes(raw)

const isMidnightIdentity = (raw: string | null): raw is BrowserMidnightIdentity =>
  raw !== null && (MIDNIGHT_IDENTITIES as readonly string[]).includes(raw)

/**
 * Turn three raw storage reads into prefs. Every unrecognised value falls back
 * to its default, including the injection flag: only the literal `'false'`
 * disables the connector, so a corrupt or partially-written value can never
 * silently make every dApp stop seeing a wallet.
 */
export const parseBrowserPrefs = (raw: {
  readonly searchEngine: string | null
  readonly walletIdentity: string | null
  readonly midnightIdentity: string | null
  readonly cardanoInjection: string | null
  readonly midnightInjection: string | null
  readonly desktopSite: string | null
}): BrowserPrefs => ({
  searchEngine: isEngine(raw.searchEngine) ? raw.searchEngine : DEFAULT_PREFS.searchEngine,
  walletIdentity: isIdentity(raw.walletIdentity) ? raw.walletIdentity : DEFAULT_PREFS.walletIdentity,
  midnightIdentity: isMidnightIdentity(raw.midnightIdentity) ? raw.midnightIdentity : DEFAULT_PREFS.midnightIdentity,
  cardanoInjectionEnabled: raw.cardanoInjection === 'false' ? false : DEFAULT_PREFS.cardanoInjectionEnabled,
  midnightInjectionEnabled: raw.midnightInjection === 'false' ? false : DEFAULT_PREFS.midnightInjectionEnabled,
  // Mirror image of the injection flag: only the literal `'true'` turns it on, so a corrupt value
  // leaves pages rendering as the mobile site they were designed for.
  desktopSite: raw.desktopSite === 'true',
})

/**
 * Synchronous read used to seed initial provider state — runs on platforms
 * with sync storage (MMKV / localStorage). Returns defaults on extension,
 * which falls back to the async hydrate after mount.
 */
export const readBrowserPrefsSync = (): BrowserPrefs =>
  parseBrowserPrefs({
    searchEngine: storage.getSync(SEARCH_ENGINE_KEY),
    walletIdentity: storage.getSync(WALLET_IDENTITY_KEY),
    midnightIdentity: storage.getSync(MIDNIGHT_IDENTITY_KEY),
    cardanoInjection: storage.getSync(CARDANO_INJECTION_KEY),
    midnightInjection: storage.getSync(MIDNIGHT_INJECTION_KEY),
    desktopSite: storage.getSync(DESKTOP_SITE_KEY),
  })

export const readBrowserPrefs = async (): Promise<BrowserPrefs> => {
  try {
    const [searchEngine, walletIdentity, midnightIdentity, cardanoInjection, midnightInjection, desktopSite] =
      await Promise.all([
        storage.get(SEARCH_ENGINE_KEY),
        storage.get(WALLET_IDENTITY_KEY),
        storage.get(MIDNIGHT_IDENTITY_KEY),
        storage.get(CARDANO_INJECTION_KEY),
        storage.get(MIDNIGHT_INJECTION_KEY),
        storage.get(DESKTOP_SITE_KEY),
      ])
    return parseBrowserPrefs({
      searchEngine,
      walletIdentity,
      midnightIdentity,
      cardanoInjection,
      midnightInjection,
      desktopSite,
    })
  } catch (error) {
    logger.warn('[BrowserPrefs] Failed to read prefs, using defaults', {error})
    return DEFAULT_PREFS
  }
}

export const writeSearchEngine = async (engine: BrowserSearchEngine): Promise<void> => {
  try {
    await storage.set(SEARCH_ENGINE_KEY, engine)
  } catch (error) {
    logger.error('[BrowserPrefs] Failed to persist searchEngine', {error})
  }
}

export const writeWalletIdentity = async (identity: BrowserWalletIdentity): Promise<void> => {
  try {
    await storage.set(WALLET_IDENTITY_KEY, identity)
  } catch (error) {
    logger.error('[BrowserPrefs] Failed to persist walletIdentity', {error})
  }
}

export const writeMidnightIdentity = async (identity: BrowserMidnightIdentity): Promise<void> => {
  try {
    await storage.set(MIDNIGHT_IDENTITY_KEY, identity)
  } catch (error) {
    logger.error('[BrowserPrefs] Failed to persist midnightIdentity', {error})
  }
}

export const writeCardanoInjectionEnabled = async (enabled: boolean): Promise<void> => {
  try {
    await storage.set(CARDANO_INJECTION_KEY, enabled ? 'true' : 'false')
  } catch (error) {
    logger.error('[BrowserPrefs] Failed to persist cardanoInjectionEnabled', {error})
  }
}

export const writeMidnightInjectionEnabled = async (enabled: boolean): Promise<void> => {
  try {
    await storage.set(MIDNIGHT_INJECTION_KEY, enabled ? 'true' : 'false')
  } catch (error) {
    logger.error('[BrowserPrefs] Failed to persist midnightInjectionEnabled', {error})
  }
}

export const writeDesktopSite = async (enabled: boolean): Promise<void> => {
  try {
    await storage.set(DESKTOP_SITE_KEY, enabled ? 'true' : 'false')
  } catch (error) {
    logger.error('[BrowserPrefs] Failed to persist desktopSite', {error})
  }
}
