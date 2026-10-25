import {describe, expect, it} from 'vitest'

import {
  buildSearchUrl,
  parseBrowserPrefs,
  SEARCH_ENGINES,
  WALLET_IDENTITIES,
  WALLET_IDENTITY_INJECTION,
} from './browser-prefs-storage'

const raw = (overrides: Partial<Parameters<typeof parseBrowserPrefs>[0]> = {}) =>
  parseBrowserPrefs({
    searchEngine: null,
    walletIdentity: null,
    midnightIdentity: null,
    cardanoInjection: null,
    midnightInjection: null,
    desktopSite: null,
    ...overrides,
  })

describe('parseBrowserPrefs', () => {
  it('defaults every field when storage is empty', () => {
    expect(raw()).toEqual({
      searchEngine: 'google',
      walletIdentity: 'pnyx',
      midnightIdentity: 'pnyx',
      cardanoInjectionEnabled: true,
      midnightInjectionEnabled: true,
      desktopSite: false,
    })
  })

  it('treats each injection switch independently', () => {
    // One chain's dApps may be allowed to see this wallet while the other's are not, so neither flag
    // may stand in for the other.
    expect(raw({cardanoInjection: 'false'}).midnightInjectionEnabled).toBe(true)
    expect(raw({midnightInjection: 'false'}).cardanoInjectionEnabled).toBe(true)
    expect(raw({midnightInjection: 'false'}).midnightInjectionEnabled).toBe(false)
  })

  it('defaults the Midnight switch on for anything but the literal "false"', () => {
    // Stored values are written by us, so an unexpected one means a corrupt read — and defaulting a
    // discovery surface *on* is the non-surprising direction.
    expect(raw({midnightInjection: 'true'}).midnightInjectionEnabled).toBe(true)
    expect(raw({midnightInjection: 'nonsense'}).midnightInjectionEnabled).toBe(true)
  })

  it('round-trips each known search engine', () => {
    for (const engine of SEARCH_ENGINES) {
      expect(raw({searchEngine: engine}).searchEngine).toBe(engine)
    }
  })

  it('round-trips each known wallet identity', () => {
    for (const identity of WALLET_IDENTITIES) {
      expect(raw({walletIdentity: identity}).walletIdentity).toBe(identity)
    }
  })

  it('falls back on values outside the known sets', () => {
    const parsed = raw({searchEngine: 'askjeeves', walletIdentity: 'nami'})
    expect(parsed.searchEngine).toBe('google')
    expect(parsed.walletIdentity).toBe('pnyx')
  })

  it('disables the connector only on the exact literal we write', () => {
    expect(raw({cardanoInjection: 'false'}).cardanoInjectionEnabled).toBe(false)
    expect(raw({cardanoInjection: 'true'}).cardanoInjectionEnabled).toBe(true)
    // A corrupt / half-written value must never read as "off" — that would make
    // every dApp stop detecting a wallet with no way for the user to see why.
    for (const corrupt of ['', 'False', 'FALSE', '0', 'no', 'fals', 'undefined', 'null']) {
      expect(raw({cardanoInjection: corrupt}).cardanoInjectionEnabled).toBe(true)
    }
  })
})

describe('WALLET_IDENTITY_INJECTION', () => {
  it('covers every selectable identity with a name and at least one provider key', () => {
    for (const identity of WALLET_IDENTITIES) {
      const injection = WALLET_IDENTITY_INJECTION[identity]
      expect(injection.walletName.length).toBeGreaterThan(0)
      expect(injection.providerNames.length).toBeGreaterThan(0)
    }
  })

  it('gives each identity a distinct set of window.cardano keys', () => {
    const keys = WALLET_IDENTITIES.flatMap((identity) => WALLET_IDENTITY_INJECTION[identity].providerNames)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('buildSearchUrl', () => {
  it('percent-encodes the query into each engine template', () => {
    for (const engine of SEARCH_ENGINES) {
      const url = buildSearchUrl(engine, 'ada staking & fees')
      expect(url).toContain('ada%20staking%20%26%20fees')
      expect(url).not.toContain('{q}')
      expect(url.startsWith('https://')).toBe(true)
    }
  })
})

// Mirror image of the injection flag: that one defaults ON so only `'false'` disables it, this one
// defaults OFF so only `'true'` enables it. A corrupt value must never silently reshape every page.
describe('desktopSite', () => {
  it('is off unless storage says exactly true', () => {
    expect(raw().desktopSite).toBe(false)
    expect(raw({desktopSite: 'true'}).desktopSite).toBe(true)
    expect(raw({desktopSite: 'false'}).desktopSite).toBe(false)
    expect(raw({desktopSite: 'TRUE'}).desktopSite).toBe(false)
    expect(raw({desktopSite: '1'}).desktopSite).toBe(false)
    expect(raw({desktopSite: ''}).desktopSite).toBe(false)
  })
})
