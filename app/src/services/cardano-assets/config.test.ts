import {afterEach, describe, expect, it, vi} from 'vitest'
import {getCardanoAssetsConfig, setRemoteSteelswapPartnerKey, setRemoteSteelswapUrl} from './config'

afterEach(() => {
  setRemoteSteelswapUrl(undefined)
  setRemoteSteelswapPartnerKey(undefined)
})

describe('the SteelSwap base', () => {
  it('defaults to devapi, not the CI host', () => {
    // Both hosts carry our live partner account, but they are separate deployments with separate
    // fee ledgers. Shipping against the one named after CI is the mistake this pins.
    expect(getCardanoAssetsConfig('mainnet').steelswapUrl).toBe('https://devapi.steelswap.io')
  })

  it('follows the control plane, which is how the embedded key gets retired', () => {
    setRemoteSteelswapUrl('https://swap.example.com')
    expect(getCardanoAssetsConfig('mainnet').steelswapUrl).toBe('https://swap.example.com')
  })

  it('strips a trailing slash, because paths are joined onto it', () => {
    setRemoteSteelswapUrl('https://swap.example.com/')
    expect(getCardanoAssetsConfig('mainnet').steelswapUrl).toBe('https://swap.example.com')
  })

  it.each([undefined, '', '   '])('treats %o as no opinion and falls back to the build', (value) => {
    // A remote config that fails to load, or publishes a blank, must not be able to take the swap
    // rail away: an empty string is an absent value here, not a base URL of "".
    setRemoteSteelswapUrl(value)
    expect(getCardanoAssetsConfig('mainnet').steelswapUrl).toBe('https://devapi.steelswap.io')
  })

  it('is the same base on every network — SteelSwap serves mainnet data only', () => {
    const bases = (['mainnet', 'preprod', 'preview'] as const).map((n) => getCardanoAssetsConfig(n).steelswapUrl)
    expect(new Set(bases).size).toBe(1)
  })
})

describe('the partner key', () => {
  it('is absent when the build declares none, rather than an empty string', () => {
    // Absent means "fall back to the per-install CIP-8 key". An empty string would read as a
    // configured credential and authenticate nothing.
    expect(getCardanoAssetsConfig('mainnet').steelswapPartnerKey).toBeUndefined()
  })

  it('comes from the control plane, which is how dev and preview stop carrying it in env', () => {
    setRemoteSteelswapPartnerKey('from-remote')
    expect(getCardanoAssetsConfig('mainnet').steelswapPartnerKey).toBe('from-remote')
  })

  it.each([undefined, '', '   '])('treats a published %o as no key at all', (value) => {
    // A blank would read as a configured credential and authenticate nothing — the one failure mode
    // that looks like a working swap quietly paying the wrong principal.
    setRemoteSteelswapPartnerKey(value)
    expect(getCardanoAssetsConfig('mainnet').steelswapPartnerKey).toBeUndefined()
  })

  it('trims what the control plane published, because JSON carries whitespace easily', () => {
    setRemoteSteelswapPartnerKey('  key-with-space  ')
    expect(getCardanoAssetsConfig('mainnet').steelswapPartnerKey).toBe('key-with-space')
  })

  it('is carried onto the config when the build declares one', async () => {
    vi.resetModules()
    vi.doMock('../../config/env', async () => ({
      ...(await vi.importActual<typeof import('../../config/env')>('../../config/env')),
      steelswapPartnerKey: () => 'partner-key',
    }))
    const {getCardanoAssetsConfig: fresh} = await import('./config')
    expect(fresh('mainnet').steelswapPartnerKey).toBe('partner-key')
    vi.doUnmock('../../config/env')
    vi.resetModules()
  })

  it('lets a build-time key outrank the control plane, as the URL does', async () => {
    vi.resetModules()
    vi.doMock('../../config/env', async () => ({
      ...(await vi.importActual<typeof import('../../config/env')>('../../config/env')),
      steelswapPartnerKey: () => 'from-env',
    }))
    const {getCardanoAssetsConfig: fresh, setRemoteSteelswapPartnerKey: setFresh} = await import('./config')
    setFresh('from-remote')
    expect(fresh('mainnet').steelswapPartnerKey).toBe('from-env')
    setFresh(undefined)
    vi.doUnmock('../../config/env')
    vi.resetModules()
  })

  it('outranks nothing about the URL — a build-time override still wins there', async () => {
    // The two are independent: a developer pointing at the dev proxy must keep that redirect even
    // once the fleet is steered somewhere else.
    vi.resetModules()
    vi.doMock('../../config/env', async () => ({
      ...(await vi.importActual<typeof import('../../config/env')>('../../config/env')),
      steelswapUrlOverride: () => 'https://local.proxy',
      steelswapPartnerKey: () => 'partner-key',
    }))
    const {getCardanoAssetsConfig: fresh, setRemoteSteelswapUrl: setFresh} = await import('./config')
    setFresh('https://swap.example.com')
    expect(fresh('mainnet').steelswapUrl).toBe('https://local.proxy')
    vi.doUnmock('../../config/env')
    vi.resetModules()
  })
})
