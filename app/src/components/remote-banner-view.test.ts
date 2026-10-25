import type {RemoteBanner} from '@pnyx/config'
import {describe, expect, it, vi} from 'vitest'

vi.mock('@pnyx/config', () => ({
  getRemoteConfigAssetUrl: (path: string) => `https://config.example.com/${path.replace(/^\/+/, '')}`,
}))

const {bannerSlot, ctaActionType, remoteBannerImageUrl, toBannerCard, visibleBanners} = await import(
  './remote-banner-view'
)

const banner = (over: Partial<RemoteBanner> = {}): RemoteBanner => ({
  id: 'b1',
  contentId: 'c1',
  type: 'info',
  isDismissible: true,
  priorityWeight: 0,
  ...over,
})

const content = {title: 'Title', message: 'Body'}

describe('bannerSlot', () => {
  it('defaults to home so pre-slot configs keep rendering', () => {
    expect(bannerSlot(banner())).toBe('home')
  })

  it('uses the declared slot', () => {
    expect(bannerSlot(banner({slot: 'home'}))).toBe('home')
  })
})

describe('remoteBannerImageUrl', () => {
  it('keeps an absolute URL', () => {
    expect(remoteBannerImageUrl('https://cdn.example.com/a.png')).toBe('https://cdn.example.com/a.png')
  })

  it('resolves a bare path against the config bucket', () => {
    expect(remoteBannerImageUrl('banners/images/a.png')).toBe('https://config.example.com/banners/images/a.png')
  })

  it('reports absence rather than an empty string', () => {
    expect(remoteBannerImageUrl(undefined)).toBeUndefined()
    expect(remoteBannerImageUrl('')).toBeUndefined()
  })
})

describe('ctaActionType', () => {
  it('treats a leading slash as an in-app route', () => {
    expect(ctaActionType('/settings/security')).toBe('navigation')
  })

  it('treats everything else as leaving the app', () => {
    expect(ctaActionType('https://pnyx.pxkq.uk/x')).toBe('link')
    expect(ctaActionType('pnyx://circle/1')).toBe('link')
  })

  it('does not mistake a protocol-relative URL for an in-app route', () => {
    // `//evil.example` starts with a slash but is an external URL, and routing it
    // through expo-router would be a navigation to a path that does not exist.
    expect(ctaActionType('//evil.example/x')).toBe('link')
  })
})

describe('visibleBanners', () => {
  it('keeps only banners for the requested slot', () => {
    const rows = [banner({id: 'a'}), banner({id: 'b', slot: 'home'})]
    expect(visibleBanners(rows, 'home', new Set()).map((b) => b.id)).toEqual(['a', 'b'])
  })

  it('drops a dismissed banner', () => {
    const rows = [banner({id: 'a'}), banner({id: 'b'})]
    expect(visibleBanners(rows, 'home', new Set(['a'])).map((b) => b.id)).toEqual(['b'])
  })

  it('keeps a non-dismissible banner even if its id was somehow recorded', () => {
    const rows = [banner({id: 'a', isDismissible: false})]
    expect(visibleBanners(rows, 'home', new Set(['a'])).map((b) => b.id)).toEqual(['a'])
  })
})

describe('toBannerCard', () => {
  it('carries copy from the fetched content, not the config', () => {
    expect(toBannerCard(banner(), content)).toMatchObject({
      bannerId: 'b1',
      title: 'Title',
      description: 'Body',
      isDismissible: true,
      priorityWeight: 0,
      testID: 'remote-banner-b1',
      hideChevron: true,
    })
  })

  it('omits the action entirely when there is no ctaLink', () => {
    const card = toBannerCard(banner(), content)
    expect(card.type).toBeUndefined()
    expect(card.destination).toBeUndefined()
  })

  it('marks an internal CTA as navigation and an external one as a link', () => {
    expect(toBannerCard(banner({ctaLink: '/wallets'}), content)).toMatchObject({
      type: 'navigation',
      destination: '/wallets',
    })
    expect(toBannerCard(banner({ctaLink: 'https://example.com'}), content)).toMatchObject({
      type: 'link',
      destination: 'https://example.com',
    })
  })

  it('resolves a bucket-relative image', () => {
    expect(toBannerCard(banner({imageUrl: 'banners/images/x.png'}), content).imageUrl).toBe(
      'https://config.example.com/banners/images/x.png',
    )
  })

  it('leaves imageUrl absent when the banner has none', () => {
    expect('imageUrl' in toBannerCard(banner(), content)).toBe(false)
  })

  it('passes through an actionLabel only when the copy carries one', () => {
    expect('actionLabel' in toBannerCard(banner(), content)).toBe(false)
    expect(toBannerCard(banner(), {...content, actionLabel: 'Open'}).actionLabel).toBe('Open')
  })
})
