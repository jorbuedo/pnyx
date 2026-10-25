import {beforeEach, describe, expect, it, vi} from 'vitest'

const load = async (env: Record<string, string | undefined>) => {
  vi.resetModules()
  vi.doMock('../../config/env', () => ({
    preprodIndexerOverride: () => env.url,
    preprodIndexerProjectId: () => env.projectId,
  }))
  return import('./indexer-auth')
}

const BLOCKFROST = 'https://midnight-preprod.blockfrost.io/api/v4/graphql'
const OURS = 'https://midnight-mainnet.pxkq.uk/api/v4/graphql'

beforeEach(() => {
  vi.resetModules()
})

describe('splitIndexerCredential', () => {
  it('leaves a url with no credential alone', async () => {
    const {splitIndexerCredential} = await load({})
    expect(splitIndexerCredential(OURS)).toEqual({url: OURS})
  })

  it('splits the project id out of the combined form', async () => {
    const {splitIndexerCredential} = await load({})
    expect(splitIndexerCredential(`${BLOCKFROST}?project_id=KEY`)).toEqual({url: BLOCKFROST, projectId: 'KEY'})
  })

  it('keeps other query parameters', async () => {
    const {splitIndexerCredential} = await load({})
    expect(splitIndexerCredential(`${BLOCKFROST}?a=1&project_id=KEY&b=2`)).toEqual({
      url: `${BLOCKFROST}?a=1&b=2`,
      projectId: 'KEY',
    })
  })
})

describe('indexerAuthHeaders', () => {
  it('sends the key to the configured host, whatever the path', async () => {
    const {indexerAuthHeaders} = await load({url: BLOCKFROST, projectId: 'KEY'})
    expect(indexerAuthHeaders(BLOCKFROST)).toEqual({project_id: 'KEY'})
    // The probe and the socket are different URLs on the same indexer.
    expect(indexerAuthHeaders(`${BLOCKFROST}/ws`)).toEqual({project_id: 'KEY'})
  })

  it('reads a key configured inside the url, so a local env file needs no migration', async () => {
    const {indexerAuthHeaders} = await load({url: `${BLOCKFROST}?project_id=INLINE`})
    expect(indexerAuthHeaders(BLOCKFROST)).toEqual({project_id: 'INLINE'})
  })

  it('prefers the separate variable when both are set', async () => {
    const {indexerAuthHeaders} = await load({url: `${BLOCKFROST}?project_id=INLINE`, projectId: 'SEPARATE'})
    expect(indexerAuthHeaders(BLOCKFROST)).toEqual({project_id: 'SEPARATE'})
  })

  it('sends nothing to another host — a key belongs to the indexer it was issued for', async () => {
    const {indexerAuthHeaders} = await load({url: BLOCKFROST, projectId: 'KEY'})
    expect(indexerAuthHeaders(OURS)).toEqual({})
    expect(indexerAuthHeaders('http://127.0.0.1:8088/api/v4/graphql')).toEqual({})
  })

  it('sends nothing when no key is configured', async () => {
    const {indexerAuthHeaders} = await load({url: BLOCKFROST})
    expect(indexerAuthHeaders(BLOCKFROST)).toEqual({})
  })
})

describe('authorizeIndexerWsUrl', () => {
  it('appends the key, because a browser websocket cannot set a header', async () => {
    const {authorizeIndexerWsUrl} = await load({url: BLOCKFROST, projectId: 'KEY'})
    expect(authorizeIndexerWsUrl('wss://midnight-preprod.blockfrost.io/api/v4/graphql/ws')).toBe(
      'wss://midnight-preprod.blockfrost.io/api/v4/graphql/ws?project_id=KEY',
    )
  })

  it('does not double a credential the url already carries', async () => {
    const {authorizeIndexerWsUrl} = await load({url: BLOCKFROST, projectId: 'KEY'})
    const already = 'wss://midnight-preprod.blockfrost.io/api/v4/graphql/ws?project_id=OTHER'
    expect(authorizeIndexerWsUrl(already)).toBe(already)
  })

  it('leaves an unkeyed host alone', async () => {
    const {authorizeIndexerWsUrl} = await load({url: BLOCKFROST, projectId: 'KEY'})
    expect(authorizeIndexerWsUrl('wss://midnight-mainnet.pxkq.uk/api/v4/graphql/ws')).toBe(
      'wss://midnight-mainnet.pxkq.uk/api/v4/graphql/ws',
    )
  })
})
