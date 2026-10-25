import {Effect} from 'effect'
import {afterEach, describe, expect, it, vi} from 'vitest'

import {
  fetchRemoteConfig,
  getBanners,
  getRemoteConfigAssetUrl,
  getRemoteConfigUrl,
  type RemoteConfig,
} from './remote-config.js'

describe('getRemoteConfigUrl', () => {
  it('returns prod URL against the localhost default by default', () => {
    const url = getRemoteConfigUrl()
    expect(url).toBe('http://localhost:8790/remote-config/prod.json')
  })

  it('returns dev URL when env is dev', () => {
    const url = getRemoteConfigUrl({env: 'dev'})
    expect(url).toBe('http://localhost:8790/remote-config/dev.json')
  })

  it('prefers EXPO_PUBLIC_REMOTE_CONFIG_URL over the localhost default', () => {
    const previous = process.env.EXPO_PUBLIC_REMOTE_CONFIG_URL
    process.env.EXPO_PUBLIC_REMOTE_CONFIG_URL = 'https://config.pnyx.pxkq.uk/remote-config'
    try {
      expect(getRemoteConfigUrl({env: 'preview'})).toBe('https://config.pnyx.pxkq.uk/remote-config/preview.json')
      expect(getRemoteConfigUrl()).toBe('https://config.pnyx.pxkq.uk/remote-config/prod.json')
    } finally {
      if (previous === undefined) {
        delete process.env.EXPO_PUBLIC_REMOTE_CONFIG_URL
      } else {
        process.env.EXPO_PUBLIC_REMOTE_CONFIG_URL = previous
      }
    }
  })

  it('prefers an explicit base URL over the environment', () => {
    const previous = process.env.EXPO_PUBLIC_REMOTE_CONFIG_URL
    process.env.EXPO_PUBLIC_REMOTE_CONFIG_URL = 'https://config.pnyx.pxkq.uk/remote-config'
    try {
      expect(getRemoteConfigUrl({baseUrl: 'https://example.com/config', env: 'prod'})).toBe(
        'https://example.com/config/prod.json',
      )
    } finally {
      if (previous === undefined) {
        delete process.env.EXPO_PUBLIC_REMOTE_CONFIG_URL
      } else {
        process.env.EXPO_PUBLIC_REMOTE_CONFIG_URL = previous
      }
    }
  })

  it('uses custom base URL', () => {
    const url = getRemoteConfigUrl({baseUrl: 'https://example.com/config', env: 'prod'})
    expect(url).toBe('https://example.com/config/prod.json')
  })

  it('uses custom base URL with dev env', () => {
    const url = getRemoteConfigUrl({baseUrl: 'https://example.com/config', env: 'dev'})
    expect(url).toBe('https://example.com/config/dev.json')
  })
})

describe('getRemoteConfigAssetUrl', () => {
  it('returns an asset URL from the default base', () => {
    const url = getRemoteConfigAssetUrl('banners/content/dev-mode/en-US.md')
    expect(url).toBe('http://localhost:8790/remote-config/banners/content/dev-mode/en-US.md')
  })

  it('strips leading slashes and supports custom base URLs', () => {
    const url = getRemoteConfigAssetUrl('/banners/images/dev.svg', {baseUrl: 'https://example.com/config'})
    expect(url).toBe('https://example.com/config/banners/images/dev.svg')
  })
})

describe('getBanners', () => {
  const current = Date.now()

  it('returns an empty array when banners are missing', () => {
    expect(getBanners(undefined)).toEqual([])
    expect(getBanners({})).toEqual([])
  })

  it('filters inactive banners by date range', () => {
    const config: RemoteConfig = {
      banners: [
        {
          id: 'future',
          contentId: 'future',
          type: 'info',
          startDate: new Date(current + 60_000).toISOString(),
          isDismissible: true,
          priorityWeight: 1,
        },
        {
          id: 'expired',
          contentId: 'expired',
          type: 'info',
          endDate: new Date(current - 60_000).toISOString(),
          isDismissible: true,
          priorityWeight: 1,
        },
        {
          id: 'active',
          contentId: 'active',
          type: 'info',
          startDate: new Date(current - 60_000).toISOString(),
          endDate: new Date(current + 60_000).toISOString(),
          isDismissible: true,
          priorityWeight: 1,
        },
      ],
    }

    expect(getBanners(config).map((banner) => banner.id)).toEqual(['active'])
  })

  it('merges platform overrides before filtering and sorting', () => {
    const config: RemoteConfig = {
      banners: [
        {
          id: 'base',
          contentId: 'base',
          type: 'info',
          isDismissible: true,
          priorityWeight: 1,
          platformOverrides: {
            ios: {
              contentId: 'base-ios',
              type: 'success',
              priorityWeight: 10,
            },
          },
        },
        {
          id: 'higher',
          contentId: 'higher',
          type: 'warning',
          isDismissible: false,
          priorityWeight: 5,
        },
      ],
    }

    const banners = getBanners(config, 'ios')

    expect(banners.map((banner) => banner.id)).toEqual(['base', 'higher'])
    expect(banners[0]).toMatchObject({
      contentId: 'base-ios',
      type: 'success',
      priorityWeight: 10,
    })
  })

  it('ignores unsafe platform override identity fields from remote JSON', () => {
    const config = {
      banners: [
        {
          id: 'base',
          contentId: 'base',
          type: 'info',
          isDismissible: true,
          priorityWeight: 1,
          platformOverrides: {
            ios: {
              id: 'base-ios',
              contentId: 'base-ios-content',
              platformOverrides: {
                android: {
                  contentId: 'nested',
                },
              },
              priorityWeight: 10,
            },
          },
        },
      ],
      // Deliberately not a `RemoteConfig`: this is what hostile remote JSON looks like — an
      // override carrying an `id` and a nested `platformOverrides`, neither of which the type allows.
    } as unknown as RemoteConfig

    const [banner] = getBanners(config, 'ios')

    expect(banner).toMatchObject({
      id: 'base',
      contentId: 'base-ios-content',
      priorityWeight: 10,
    })
    expect(banner?.platformOverrides).toBe(config.banners?.[0]?.platformOverrides)
  })

  it('sorts active banners by descending priority', () => {
    const config: RemoteConfig = {
      banners: [
        {
          id: 'low',
          contentId: 'low',
          type: 'info',
          isDismissible: true,
          priorityWeight: 1,
        },
        {
          id: 'high',
          contentId: 'high',
          type: 'error',
          isDismissible: false,
          priorityWeight: 100,
        },
      ],
    }

    expect(getBanners(config).map((banner) => banner.id)).toEqual(['high', 'low'])
  })
})

describe('fetchRemoteConfig', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const stubFetch = (body: unknown) => {
    const spy = vi.fn(async () => new Response(JSON.stringify(body), {status: 200}))
    vi.stubGlobal('fetch', spy)
    return spy
  }

  it('never reads the config from an HTTP cache', async () => {
    // React Native's OkHttp client keeps an on-disk response cache and honours
    // the `max-age=300` these objects are published with. That served a stale
    // config to the app while the same URL in a browser on the same device
    // returned the new one — and the fetch still logged success, so the app
    // looked healthy while showing week-old data.
    const spy = stubFetch({dapps: {recommended: []}})
    await Effect.runPromise(fetchRemoteConfig('https://config.example.com/dev.json'))

    expect(spy).toHaveBeenCalledWith(
      'https://config.example.com/dev.json',
      expect.objectContaining({
        cache: 'no-store',
        headers: expect.objectContaining({'Cache-Control': 'no-cache'}),
      }),
    )
  })

  it('returns the parsed config', async () => {
    stubFetch({dapps: {recommended: [{id: 'a'}]}})
    const config = await Effect.runPromise(fetchRemoteConfig('https://config.example.com/dev.json'))
    expect(config.dapps?.recommended).toHaveLength(1)
  })

  it('fails with ConfigLoadError on a non-2xx response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', {status: 404})),
    )
    const result = await Effect.runPromise(Effect.either(fetchRemoteConfig('https://config.example.com/dev.json')))
    expect(result._tag).toBe('Left')
  })
})
