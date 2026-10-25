/**
 * How `networks.ts` chooses between the built-in table, the control plane and the device.
 *
 * Separate from `networks.test.ts`, which pins the built-in table itself: that file must keep
 * asserting the shipped URLs with nothing installed, and these cases install things.
 */
import {beforeEach, describe, expect, it, vi} from 'vitest'

vi.mock('../../logger', () => ({logger: {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}}))

import {
  applyUserEndpointOverride,
  getEndpointRegistrySnapshot,
  resetEndpointOverridesForTest,
  setRemoteNetworkRules,
} from './endpoint-overrides'
import {
  describeMidnightEndpoint,
  midnightIndexerFor,
  midnightIndexerWsFor,
  midnightNodeFor,
  midnightNodeWsFor,
} from './networks'

beforeEach(() => {
  resetEndpointOverridesForTest()
})

describe('precedence', () => {
  it('uses the built-in table when nothing else has spoken', () => {
    expect(midnightIndexerFor('preprod')).toBe('https://indexer.preprod.midnight.network/api/v4/graphql')
  })

  it('prefers the control plane over the build', () => {
    setRemoteNetworkRules({midnight: {preprod: {endpoints: {indexer: 'https://fleet.example.com/api/v4/graphql'}}}})
    expect(midnightIndexerFor('preprod')).toBe('https://fleet.example.com/api/v4/graphql')
  })

  it('prefers the device over the control plane', () => {
    setRemoteNetworkRules({midnight: {preprod: {endpoints: {indexer: 'https://fleet.example.com/api/v4/graphql'}}}})
    applyUserEndpointOverride('preprod', 'indexer', 'https://mine.example.com/api/v4/graphql')
    expect(midnightIndexerFor('preprod')).toBe('https://mine.example.com/api/v4/graphql')
  })

  it('overrides one network without touching its neighbours', () => {
    applyUserEndpointOverride('preprod', 'indexer', 'https://mine.example.com/api/v4/graphql')
    expect(midnightIndexerFor('mainnet')).toBe('https://midnight-mainnet.pxkq.uk/api/v4/graphql')
    expect(midnightIndexerFor('preview')).toBe('https://indexer.preview.midnight.network/api/v4/graphql')
  })

  it('overrides one kind without touching the others', () => {
    applyUserEndpointOverride('preprod', 'node', 'http://10.0.2.2:9944')
    expect(midnightNodeFor('preprod')).toBe('http://10.0.2.2:9944')
    expect(midnightIndexerFor('preprod')).toBe('https://indexer.preprod.midnight.network/api/v4/graphql')
  })
})

describe('the kill switch', () => {
  it('withholds every endpoint for a pair the control plane switched off', () => {
    setRemoteNetworkRules({midnight: {mainnet: {enabled: false, reasonCode: 'decommissioned'}}})
    expect(midnightIndexerFor('mainnet')).toBeNull()
    expect(midnightNodeFor('mainnet')).toBeNull()
    expect(midnightNodeWsFor('mainnet')).toBeNull()
    expect(midnightIndexerWsFor('mainnet')).toBeNull()
  })

  it('leaves the other networks alone — the 2026-09-30 shape', () => {
    setRemoteNetworkRules({midnight: {mainnet: {enabled: false}}})
    expect(midnightIndexerFor('preprod')).toBe('https://indexer.preprod.midnight.network/api/v4/graphql')
    expect(midnightIndexerFor('preview')).toBe('https://indexer.preview.midnight.network/api/v4/graphql')
  })

  it('outranks a device override: a switched-off chain stays off however it was configured', () => {
    applyUserEndpointOverride('mainnet', 'indexer', 'https://mine.example.com/api/v4/graphql')
    setRemoteNetworkRules({midnight: {mainnet: {enabled: false}}})
    expect(midnightIndexerFor('mainnet')).toBeNull()
  })

  it('does not shut Midnight down because Cardano was switched off', () => {
    setRemoteNetworkRules({cardano: {mainnet: {enabled: false}}})
    expect(midnightIndexerFor('mainnet')).toBe('https://midnight-mainnet.pxkq.uk/api/v4/graphql')
  })
})

describe('derived websockets', () => {
  it('derives the indexer socket from whichever indexer URL won', () => {
    applyUserEndpointOverride('preprod', 'indexer', 'https://mine.example.com/api/v4/graphql')
    expect(midnightIndexerWsFor('preprod')).toBe('wss://mine.example.com/api/v4/graphql/ws')
  })

  it('follows an overridden node rather than leaving the socket on the built-in host', () => {
    applyUserEndpointOverride('preprod', 'node', 'https://rpc.mine.example.com')
    expect(midnightNodeWsFor('preprod')).toBe('wss://rpc.mine.example.com')
  })

  it('uses an explicit socket override when one is given', () => {
    applyUserEndpointOverride('preprod', 'node', 'https://rpc.mine.example.com')
    applyUserEndpointOverride('preprod', 'nodeWs', 'wss://ws.mine.example.com')
    expect(midnightNodeWsFor('preprod')).toBe('wss://ws.mine.example.com')
  })

  it('keeps the built-in socket when nothing was overridden', () => {
    expect(midnightNodeWsFor('preprod')).toBe('wss://rpc.preprod.midnight.network')
  })
})

describe('describeMidnightEndpoint', () => {
  it('names the source so the screen can say where a value came from', () => {
    expect(describeMidnightEndpoint('preprod', 'indexer').source).toBe('builtin')
    setRemoteNetworkRules({midnight: {preprod: {endpoints: {indexer: 'https://fleet.example.com/graphql'}}}})
    expect(describeMidnightEndpoint('preprod', 'indexer').source).toBe('remote')
    applyUserEndpointOverride('preprod', 'indexer', 'https://mine.example.com/graphql')
    expect(describeMidnightEndpoint('preprod', 'indexer').source).toBe('user')
  })

  it('reports the fallback, which is what clearing the field would restore', () => {
    setRemoteNetworkRules({midnight: {preprod: {endpoints: {indexer: 'https://fleet.example.com/graphql'}}}})
    applyUserEndpointOverride('preprod', 'indexer', 'https://mine.example.com/graphql')
    const described = describeMidnightEndpoint('preprod', 'indexer')
    expect(described.effective).toBe('https://mine.example.com/graphql')
    expect(described.fallback).toBe('https://fleet.example.com/graphql')
    expect(described.builtin).toBe('https://indexer.preprod.midnight.network/api/v4/graphql')
  })

  it('still describes a switched-off network, so the screen can show what is configured and why it is unused', () => {
    setRemoteNetworkRules({midnight: {mainnet: {enabled: false, reasonCode: 'decommissioned'}}})
    const described = describeMidnightEndpoint('mainnet', 'indexer')
    expect(described.builtin).toBe('https://midnight-mainnet.pxkq.uk/api/v4/graphql')
    expect(midnightIndexerFor('mainnet')).toBeNull()
  })
})

describe('the registry snapshot', () => {
  it('changes identity on every write, which is what a React store subscriber needs', () => {
    const first = getEndpointRegistrySnapshot()
    applyUserEndpointOverride('preprod', 'indexer', 'https://mine.example.com/graphql')
    const second = getEndpointRegistrySnapshot()
    expect(second).not.toBe(first)
    expect(second.user.preprod?.indexer).toBe('https://mine.example.com/graphql')
  })

  it('is stable between writes, so a store subscriber cannot loop', () => {
    expect(getEndpointRegistrySnapshot()).toBe(getEndpointRegistrySnapshot())
  })

  it('changes when the control plane speaks, not only when the device does', () => {
    const before = getEndpointRegistrySnapshot()
    setRemoteNetworkRules({midnight: {mainnet: {enabled: false}}})
    expect(getEndpointRegistrySnapshot()).not.toBe(before)
  })

  it('describes an endpoint from the snapshot it is handed, not from module state', () => {
    // The React Compiler shape: the caller passes the snapshot so the data flow is visible. Handing
    // it a stale snapshot must produce the stale answer rather than quietly reading the live store.
    const stale = getEndpointRegistrySnapshot()
    applyUserEndpointOverride('preprod', 'indexer', 'https://newer.example.com/graphql')
    expect(describeMidnightEndpoint('preprod', 'indexer', stale).effective).not.toBe(
      'https://newer.example.com/graphql',
    )
    expect(describeMidnightEndpoint('preprod', 'indexer').effective).toBe('https://newer.example.com/graphql')
  })
})
