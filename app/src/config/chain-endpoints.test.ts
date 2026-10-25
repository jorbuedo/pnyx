import {describe, expect, it} from 'vitest'

import {indexerWebsocketUrl, resolveEndpoint, validateEndpoint} from './chain-endpoints'

describe('validateEndpoint', () => {
  it('accepts the shapes each kind is reached through', () => {
    expect(validateEndpoint('indexer', 'https://indexer.example.com/api/v4/graphql')).toEqual({
      ok: true,
      url: 'https://indexer.example.com/api/v4/graphql',
    })
    expect(validateEndpoint('node', 'http://192.168.0.10:9944')).toEqual({ok: true, url: 'http://192.168.0.10:9944'})
    expect(validateEndpoint('nodeWs', 'wss://rpc.example.com')).toEqual({ok: true, url: 'wss://rpc.example.com'})
  })

  it('rejects a websocket scheme for an HTTP endpoint and the reverse', () => {
    // The failure this prevents is silent: a wrong scheme configures fine and errors later, inside a
    // sync, looking exactly like the network being down.
    expect(validateEndpoint('indexer', 'wss://indexer.example.com/graphql')).toEqual({ok: false, reason: 'scheme'})
    expect(validateEndpoint('nodeWs', 'https://rpc.example.com')).toEqual({ok: false, reason: 'scheme'})
  })

  it('rejects what does not parse, and what parses without a host', () => {
    expect(validateEndpoint('indexer', 'not a url')).toEqual({ok: false, reason: 'malformed'})
    expect(validateEndpoint('indexer', 'https://')).toEqual({ok: false, reason: 'malformed'})
    expect(validateEndpoint('indexer', 'file:///etc/hosts')).toEqual({ok: false, reason: 'scheme'})
  })

  it('drops surrounding whitespace, which a pasted URL routinely carries', () => {
    expect(validateEndpoint('indexer', '  https://indexer.example.com/graphql \n')).toEqual({
      ok: true,
      url: 'https://indexer.example.com/graphql',
    })
  })
})

describe('resolveEndpoint', () => {
  const builtin = 'https://builtin.example.com/graphql'
  const remote = 'https://remote.example.com/graphql'
  const user = 'https://user.example.com/graphql'

  it('prefers the person holding the device, then the control plane, then the build', () => {
    expect(resolveEndpoint({user, remote, builtin})).toEqual({value: user, source: 'user'})
    expect(resolveEndpoint({remote, builtin})).toEqual({value: remote, source: 'remote'})
    expect(resolveEndpoint({builtin})).toEqual({value: builtin, source: 'builtin'})
  })

  it('treats blank as absent at every level, so clearing a field falls through', () => {
    expect(resolveEndpoint({user: '   ', remote, builtin})).toEqual({value: remote, source: 'remote'})
    expect(resolveEndpoint({user: '', remote: '', builtin})).toEqual({value: builtin, source: 'builtin'})
  })

  it('reports no endpoint rather than an empty string when nothing names one', () => {
    expect(resolveEndpoint({})).toEqual({value: null, source: 'none'})
    expect(resolveEndpoint({user: null, remote: undefined, builtin: ''})).toEqual({value: null, source: 'none'})
  })
})

describe('indexerWebsocketUrl', () => {
  it('derives the subscription URL the Midnight indexer publishes', () => {
    expect(indexerWebsocketUrl('https://indexer.preprod.midnight.network/api/v4/graphql')).toBe(
      'wss://indexer.preprod.midnight.network/api/v4/graphql/ws',
    )
    expect(indexerWebsocketUrl('http://127.0.0.1:8088/api/v4/graphql/')).toBe('ws://127.0.0.1:8088/api/v4/graphql/ws')
  })
})

describe('indexerWebsocketUrl with query-authenticated providers', () => {
  it('puts /ws before the query string, not after it', () => {
    // Blockfrost authenticates with `?project_id=…` for clients that cannot set a header. Measured
    // against the real endpoint: `/api/v0/ws?project_id=…` opens, `/api/v0?project_id=…/ws` is
    // refused outright, so appending blindly produces a URL that cannot connect.
    expect(indexerWebsocketUrl('https://midnight-mainnet.blockfrost.io/api/v0?project_id=abc123')).toBe(
      'wss://midnight-mainnet.blockfrost.io/api/v0/ws?project_id=abc123',
    )
  })

  it('leaves a plain URL exactly as it was before', () => {
    expect(indexerWebsocketUrl('https://indexer.preprod.midnight.network/api/v4/graphql')).toBe(
      'wss://indexer.preprod.midnight.network/api/v4/graphql/ws',
    )
  })

  it('keeps a fragment behind the path too', () => {
    expect(indexerWebsocketUrl('https://example.com/api/v0?a=1#frag')).toBe('wss://example.com/api/v0/ws?a=1#frag')
  })
})
