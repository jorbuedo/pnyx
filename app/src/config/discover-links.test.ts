import type {RemoteDappConfig} from '@pnyx/config'
import {describe, expect, it} from 'vitest'
import {type DiscoverDapp, discoverDappsFrom, discoverIconUri} from './discover-links'

type RemoteEntry = NonNullable<RemoteDappConfig['recommended']>[number]

const entry = (over: Partial<RemoteEntry> = {}): RemoteEntry => ({
  id: 'glacier-redeem',
  name: 'Glacier Redeem',
  description: 'Redeem your NIGHT airdrop',
  category: 'Claim',
  logo: 'https://glacier-redeem.pxkq.uk/icon.png',
  uri: 'https://glacier-redeem.pxkq.uk',
  origins: ['https://glacier-redeem.pxkq.uk'],
  ...over,
})

describe('discoverDappsFrom', () => {
  // Deliberate: no offline fallback, so a shipped tile can never outlive the
  // dApp it pointed at. Remote config is the only source of discover tiles.
  it('yields no tiles when there is no remote dapps block', () => {
    expect(discoverDappsFrom(undefined)).toEqual([])
  })

  it('yields no tiles when the block carries no recommended array', () => {
    expect(discoverDappsFrom({} as RemoteDappConfig)).toEqual([])
    expect(discoverDappsFrom({banned: ['https://evil.example']} as RemoteDappConfig)).toEqual([])
  })

  it('yields no tiles when recommended is empty', () => {
    expect(discoverDappsFrom({recommended: []} as RemoteDappConfig)).toEqual([])
  })

  it('maps remote entries to tiles, taking url from uri', () => {
    expect(discoverDappsFrom({recommended: [entry()]} as RemoteDappConfig)).toEqual([
      {
        id: 'glacier-redeem',
        name: 'Glacier Redeem',
        url: 'https://glacier-redeem.pxkq.uk',
        logo: 'https://glacier-redeem.pxkq.uk/icon.png',
        categories: ['Claim'],
      },
    ])
  })

  it('carries the category through as a list, without inventing a separator', () => {
    const [tile] = discoverDappsFrom({recommended: [entry({category: 'DeFi, Staking'})]} as RemoteDappConfig)
    // One remote string is one label. Splitting on the comma would be reading a format the config
    // never promised — if multiple categories are wanted, the config should send an array.
    expect(tile?.categories).toEqual(['DeFi, Staking'])
  })

  it('yields no categories when the remote entry has none', () => {
    const [tile] = discoverDappsFrom({recommended: [entry({category: ''})]} as RemoteDappConfig)
    expect(tile?.categories).toEqual([])
  })

  it('omits logo entirely when the remote entry has none, so the icon resolver can fall back', () => {
    const [tile] = discoverDappsFrom({recommended: [entry({logo: ''})]} as RemoteDappConfig)
    expect(tile).toEqual({
      id: 'glacier-redeem',
      name: 'Glacier Redeem',
      url: 'https://glacier-redeem.pxkq.uk',
      categories: ['Claim'],
    })
    expect('logo' in (tile ?? {})).toBe(false)
  })
})

describe('discoverIconUri', () => {
  it('returns the explicit logo when set', () => {
    const dapp: DiscoverDapp = {
      id: 'g',
      name: 'Glacier',
      url: 'https://glacier-redeem.pxkq.uk',
      logo: 'https://x/icon.png',
      categories: [],
    }
    expect(discoverIconUri(dapp)).toBe('https://x/icon.png')
  })

  it('returns null when there is no logo, rather than calling a third-party favicon service', () => {
    const dapp: DiscoverDapp = {id: 's', name: 'Some dApp', url: 'https://app.example.com/path?q=1', categories: []}
    expect(discoverIconUri(dapp)).toBeNull()
  })

  it('never returns a url the app did not get from remote config', () => {
    // Guards the Third-Party API policy: the start page must not leak which dApps a user
    // browses to anyone. Any host here other than the configured `logo` is a regression.
    for (const url of ['https://app.example.com', 'not a url', 'https://x.io/a?b=c#d']) {
      expect(discoverIconUri({id: 'n', name: 'n', url, categories: []})).toBeNull()
    }
    expect(
      discoverIconUri({
        id: 'n',
        name: 'n',
        url: 'https://app.example.com',
        logo: 'https://cdn.ours/i.png',
        categories: [],
      }),
    ).toBe('https://cdn.ours/i.png')
  })

  it('returns null when the url is unparseable and there is no logo', () => {
    const dapp: DiscoverDapp = {id: 'b', name: 'Broken', url: 'not a url', categories: []}
    expect(discoverIconUri(dapp)).toBeNull()
  })
})
