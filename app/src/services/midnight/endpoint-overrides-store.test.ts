import {beforeEach, describe, expect, it, vi} from 'vitest'

const mocks = vi.hoisted(() => ({
  get: vi.fn<(key: string) => Promise<string | null>>(),
  set: vi.fn<(key: string, value: string) => Promise<void>>(),
  remove: vi.fn<(key: string) => Promise<void>>(),
}))

vi.mock('../../platform/storage', () => ({
  storage: {get: mocks.get, set: mocks.set, remove: mocks.remove},
  storageSupportsSyncGet: true,
}))
vi.mock('../../logger', () => ({logger: {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}}))

import {currentUserOverrides, resetEndpointOverridesForTest, userEndpointOverride} from './endpoint-overrides'
import {
  clearNetworkEndpointOverrides,
  loadEndpointOverrides,
  MIDNIGHT_ENDPOINTS_KEY,
  parseStoredOverrides,
  saveUserEndpointOverride,
  serializeOverrides,
} from './endpoint-overrides-store'

beforeEach(() => {
  resetEndpointOverridesForTest()
  mocks.get.mockReset().mockResolvedValue(null)
  mocks.set.mockReset().mockResolvedValue(undefined)
  mocks.remove.mockReset().mockResolvedValue(undefined)
})

describe('parseStoredOverrides', () => {
  it('reads back what serializeOverrides wrote', () => {
    const overrides = {preprod: {indexer: 'https://a.example.com/graphql', nodeWs: 'wss://b.example.com'}}
    expect(parseStoredOverrides(serializeOverrides(overrides))).toEqual(overrides)
  })

  it('ignores absent, empty and unparseable values rather than throwing into a boot path', () => {
    expect(parseStoredOverrides(null)).toEqual({})
    expect(parseStoredOverrides('')).toEqual({})
    expect(parseStoredOverrides('{not json')).toEqual({})
  })

  it('discards a version it does not understand instead of guessing at the shape', () => {
    const raw = JSON.stringify({version: 99, networks: {preprod: {indexer: 'https://x.example'}}})
    expect(parseStoredOverrides(raw)).toEqual({})
  })

  it('keeps only known networks and kinds — a stray key would become a URL the wallet calls', () => {
    const raw = JSON.stringify({
      version: 1,
      networks: {
        preprod: {indexer: 'https://ok.example.com/graphql', bogus: 'https://evil.example.com'},
        sandbox: {indexer: 'https://nope.example.com'},
      },
    })
    expect(parseStoredOverrides(raw)).toEqual({preprod: {indexer: 'https://ok.example.com/graphql'}})
  })

  it('drops blanks and trims, so a stored blank cannot shadow the built-in endpoint', () => {
    const raw = JSON.stringify({version: 1, networks: {preprod: {indexer: '   ', node: '  https://n.example  '}}})
    expect(parseStoredOverrides(raw)).toEqual({preprod: {node: 'https://n.example'}})
  })
})

describe('loadEndpointOverrides', () => {
  it('installs what was persisted', async () => {
    mocks.get.mockResolvedValue(serializeOverrides({mainnet: {indexer: 'https://mine.example.com/graphql'}}))
    await loadEndpointOverrides()
    expect(mocks.get).toHaveBeenCalledWith(MIDNIGHT_ENDPOINTS_KEY)
    expect(userEndpointOverride('mainnet', 'indexer')).toBe('https://mine.example.com/graphql')
  })

  it('leaves the registry empty when the read fails, rather than throwing into boot', async () => {
    mocks.get.mockRejectedValue(new Error('storage unavailable'))
    await expect(loadEndpointOverrides()).resolves.toBeUndefined()
    expect(currentUserOverrides()).toEqual({})
  })
})

describe('saveUserEndpointOverride', () => {
  it('is live in memory before persistence resolves', async () => {
    const pending = saveUserEndpointOverride('preprod', 'indexer', 'https://mine.example.com/graphql')
    expect(userEndpointOverride('preprod', 'indexer')).toBe('https://mine.example.com/graphql')
    await pending
    expect(mocks.set).toHaveBeenCalledWith(
      MIDNIGHT_ENDPOINTS_KEY,
      serializeOverrides({preprod: {indexer: 'https://mine.example.com/graphql'}}),
    )
  })

  it('clears one kind without disturbing its siblings', async () => {
    await saveUserEndpointOverride('preprod', 'indexer', 'https://i.example.com/graphql')
    await saveUserEndpointOverride('preprod', 'node', 'https://n.example.com')
    await saveUserEndpointOverride('preprod', 'indexer', null)
    expect(currentUserOverrides()).toEqual({preprod: {node: 'https://n.example.com'}})
  })

  it('removes the key entirely once the last override is gone', async () => {
    await saveUserEndpointOverride('preprod', 'indexer', 'https://i.example.com/graphql')
    await saveUserEndpointOverride('preprod', 'indexer', null)
    expect(mocks.remove).toHaveBeenCalledWith(MIDNIGHT_ENDPOINTS_KEY)
    expect(currentUserOverrides()).toEqual({})
  })

  it('keeps the live value when persistence fails, and does not throw at the caller', async () => {
    mocks.set.mockRejectedValue(new Error('disk full'))
    await expect(saveUserEndpointOverride('preprod', 'node', 'https://n.example.com')).resolves.toBeUndefined()
    expect(userEndpointOverride('preprod', 'node')).toBe('https://n.example.com')
  })
})

describe('clearNetworkEndpointOverrides', () => {
  it('drops every kind for one network and leaves the others alone', async () => {
    await saveUserEndpointOverride('preprod', 'indexer', 'https://i.example.com/graphql')
    await saveUserEndpointOverride('preprod', 'nodeWs', 'wss://n.example.com')
    await saveUserEndpointOverride('mainnet', 'indexer', 'https://m.example.com/graphql')
    await clearNetworkEndpointOverrides('preprod')
    expect(currentUserOverrides()).toEqual({mainnet: {indexer: 'https://m.example.com/graphql'}})
  })
})
