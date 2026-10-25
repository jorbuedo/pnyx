import {beforeEach, describe, expect, it, vi} from 'vitest'
import {storage} from '../platform/storage'
import {
  _resetInFlightFetches,
  fetchRemoteBannerContent,
  getRemoteBannerContentCacheKey,
  loadCachedRemoteBannerContent,
  parseRemoteBannerMarkdown,
  pruneRemoteBannerContent,
} from './remote-banner-content'

vi.mock('@pnyx/config', () => ({
  getRemoteConfigAssetUrl: (path: string) => `https://config.example.com/${path}`,
}))

vi.mock('../logger', () => ({
  logger: {
    warn: vi.fn(),
    debug: vi.fn(),
  },
}))

vi.mock('../platform/storage', () => ({
  storage: {
    get: vi.fn(),
    set: vi.fn(),
    getAllKeys: vi.fn(),
    remove: vi.fn(),
  },
}))

const markdown = `# Secure your wallet

Back up your wallet to keep your funds safe.

[cta]: Back up now`

describe('remote-banner-content', () => {
  beforeEach(() => {
    vi.mocked(storage.get).mockReset()
    vi.mocked(storage.get).mockResolvedValue(null)
    vi.mocked(storage.set).mockReset()
    vi.mocked(storage.set).mockResolvedValue(undefined)
    vi.mocked(storage.getAllKeys).mockReset()
    vi.mocked(storage.getAllKeys).mockResolvedValue([])
    vi.mocked(storage.remove).mockReset()
    vi.mocked(storage.remove).mockResolvedValue(undefined)
    _resetInFlightFetches()
  })

  it('parses title, message, and cta from markdown', () => {
    expect(parseRemoteBannerMarkdown(markdown)).toEqual({
      title: 'Secure your wallet',
      message: 'Back up your wallet to keep your funds safe.',
      actionLabel: 'Back up now',
    })
  })

  it('fetches localized markdown and caches it', async () => {
    const fetchText = vi.fn(async () => markdown)

    const content = await fetchRemoteBannerContent({contentId: 'secure-wallet', locale: 'es-ES'}, fetchText)

    expect(content?.title).toBe('Secure your wallet')
    expect(fetchText).toHaveBeenCalledWith('https://config.example.com/banners/content/secure-wallet/es-ES.md')
    expect(storage.set).toHaveBeenCalledWith(getRemoteBannerContentCacheKey('secure-wallet', 'es-ES'), markdown)
  })

  it('falls back to en-US when localized markdown is missing', async () => {
    const fetchText = vi.fn(async (url: string) => (url.endsWith('/en-US.md') ? markdown : null))

    const content = await fetchRemoteBannerContent({contentId: 'secure-wallet', locale: 'ja-JP'}, fetchText)

    expect(content?.message).toBe('Back up your wallet to keep your funds safe.')
    expect(fetchText).toHaveBeenCalledTimes(2)
  })

  it('loads cached markdown', async () => {
    vi.mocked(storage.get).mockResolvedValue(markdown)

    const content = await loadCachedRemoteBannerContent({contentId: 'secure-wallet', locale: 'pt-BR'})

    expect(content?.actionLabel).toBe('Back up now')
    expect(storage.get).toHaveBeenCalledWith(getRemoteBannerContentCacheKey('secure-wallet', 'pt-BR'))
  })

  it('returns null when remote copy cannot be loaded', async () => {
    const fetchText = vi.fn(async () => null)

    await expect(fetchRemoteBannerContent({contentId: 'secure-wallet', locale: 'pt-BR'}, fetchText)).resolves.toBeNull()
  })

  it('returns null when cached copy cannot be loaded', async () => {
    await expect(loadCachedRemoteBannerContent({contentId: 'secure-wallet', locale: 'pt-BR'})).resolves.toBeNull()
  })

  describe('pruneRemoteBannerContent', () => {
    it('removes every cached locale for a given contentId', async () => {
      vi.mocked(storage.getAllKeys).mockResolvedValue([
        getRemoteBannerContentCacheKey('secure-wallet', 'en-US'),
        getRemoteBannerContentCacheKey('secure-wallet', 'ja-JP'),
        getRemoteBannerContentCacheKey('other-banner', 'en-US'),
        '@pnyx/unrelated-key',
      ])

      await pruneRemoteBannerContent('secure-wallet')

      // Both locales of the target contentId removed.
      expect(storage.remove).toHaveBeenCalledWith(getRemoteBannerContentCacheKey('secure-wallet', 'en-US'))
      expect(storage.remove).toHaveBeenCalledWith(getRemoteBannerContentCacheKey('secure-wallet', 'ja-JP'))
      // Other contentIds and unrelated keys are untouched.
      expect(storage.remove).not.toHaveBeenCalledWith(getRemoteBannerContentCacheKey('other-banner', 'en-US'))
      expect(storage.remove).not.toHaveBeenCalledWith('@pnyx/unrelated-key')
    })

    it('is a no-op when nothing matches', async () => {
      vi.mocked(storage.getAllKeys).mockResolvedValue(['@pnyx/unrelated-key'])
      await pruneRemoteBannerContent('secure-wallet')
      expect(storage.remove).not.toHaveBeenCalled()
    })

    it('swallows storage enumeration failures', async () => {
      vi.mocked(storage.getAllKeys).mockRejectedValue(new Error('storage broken'))
      await expect(pruneRemoteBannerContent('secure-wallet')).resolves.toBeUndefined()
    })
  })

  describe('in-flight fetch dedup', () => {
    it('concurrent calls with same contentId+locale share one fetch', async () => {
      const gate = {resolve: (_v: string | null) => {}}
      const deferred = new Promise<string | null>((r) => {
        gate.resolve = r
      })
      const fetchText = vi.fn(() => deferred)

      const p1 = fetchRemoteBannerContent({contentId: 'banner-a', locale: 'en-US'}, fetchText)
      const p2 = fetchRemoteBannerContent({contentId: 'banner-a', locale: 'en-US'}, fetchText)

      // Only one underlying fetch despite two calls
      expect(fetchText).toHaveBeenCalledTimes(1)

      gate.resolve(markdown)
      const [r1, r2] = await Promise.all([p1, p2])
      expect(r1?.title).toBe('Secure your wallet')
      expect(r2?.title).toBe('Secure your wallet')
    })

    it('after promise settles, result is cached — no re-fetch within TTL', async () => {
      const fetchText = vi.fn(async () => markdown)

      const r1 = await fetchRemoteBannerContent({contentId: 'banner-b', locale: 'en-US'}, fetchText)
      expect(fetchText).toHaveBeenCalledTimes(1)
      expect(r1?.title).toBe('Secure your wallet')

      // Second call within TTL — returns cached result, no new fetch
      const r2 = await fetchRemoteBannerContent({contentId: 'banner-b', locale: 'en-US'}, fetchText)
      expect(fetchText).toHaveBeenCalledTimes(1) // still 1
      expect(r2?.title).toBe('Secure your wallet')
    })

    it('failed fetch does not cache the rejection — next call retries', async () => {
      const fetchText = vi
        .fn<(url: string) => Promise<string | null>>()
        .mockRejectedValueOnce(new Error('network down'))
        .mockResolvedValueOnce(markdown)

      const r1 = await fetchRemoteBannerContent({contentId: 'banner-c', locale: 'en-US'}, fetchText)
      expect(r1).toBeNull() // failed → null

      const r2 = await fetchRemoteBannerContent({contentId: 'banner-c', locale: 'en-US'}, fetchText)
      expect(r2?.title).toBe('Secure your wallet') // retried successfully
      expect(fetchText).toHaveBeenCalledTimes(2)
    })

    it('different contentId+locale pairs do not interfere', async () => {
      const gateA = {resolve: (_v: string | null) => {}}
      const gateB = {resolve: (_v: string | null) => {}}
      const deferredA = new Promise<string | null>((r) => {
        gateA.resolve = r
      })
      const deferredB = new Promise<string | null>((r) => {
        gateB.resolve = r
      })
      const fetchText = vi.fn((url: string) => (url.includes('banner-x') ? deferredA : deferredB))

      const pA = fetchRemoteBannerContent({contentId: 'banner-x', locale: 'en-US'}, fetchText)
      const pB = fetchRemoteBannerContent({contentId: 'banner-y', locale: 'en-US'}, fetchText)

      expect(pA).not.toBe(pB)
      expect(fetchText).toHaveBeenCalledTimes(2)

      gateA.resolve(markdown)
      gateB.resolve(markdown)
      await Promise.all([pA, pB])
    })
  })
})
