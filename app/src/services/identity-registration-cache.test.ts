import {beforeEach, describe, expect, it, vi} from 'vitest'

const {mocks} = vi.hoisted(() => ({
  mocks: {
    getSync: vi.fn<(key: string) => string | null>(),
    set: vi.fn<(key: string, value: string) => Promise<void>>(),
    remove: vi.fn<(key: string) => Promise<void>>(),
    warn: vi.fn(),
  },
}))

vi.mock('../platform/storage', () => ({
  storage: {getSync: mocks.getSync, set: mocks.set, remove: mocks.remove},
}))

vi.mock('../logger', () => ({
  logger: {warn: mocks.warn, info: vi.fn(), debug: vi.fn(), error: vi.fn()},
}))

const {clearIdentityRegistered, isIdentityRegistered, markIdentityRegistered} = await import(
  './identity-registration-cache'
)

const SCOPE = {
  identity: 'pnyx_id1c6jwv36qnfljuc4kxmhpkywzc90hlfrnx66elpy465y726nd48wssgnxwj',
  network: 'preprod',
  contractAddress: '92a592d617f83184c29fa2a5f1460c5bdcf67f474d51e3cec5243216f46a7128',
}

describe('identity registration cache', () => {
  beforeEach(() => {
    mocks.getSync.mockReset()
    mocks.set.mockReset().mockResolvedValue(undefined)
    mocks.remove.mockReset().mockResolvedValue(undefined)
    mocks.warn.mockReset()
  })

  it('round-trips a marked registration under one key', async () => {
    await markIdentityRegistered(SCOPE)

    const [key, value] = mocks.set.mock.calls[0] ?? []
    expect(value).toBe('1')
    mocks.getSync.mockImplementation((k) => (k === key ? '1' : null))
    expect(isIdentityRegistered(SCOPE)).toBe(true)
  })

  it('misses when the contract address changes, so a redeploy re-registers', async () => {
    await markIdentityRegistered(SCOPE)
    const [key] = mocks.set.mock.calls[0] ?? []
    mocks.getSync.mockImplementation((k) => (k === key ? '1' : null))

    // The whole point of keying on the address: a row published against the old contract says
    // nothing about the new one, and trusting it would skip registration into a refused login.
    expect(isIdentityRegistered({...SCOPE, contractAddress: 'a'.repeat(64)})).toBe(false)
  })

  it('misses on a different network — the same seed is a different identity per network', async () => {
    await markIdentityRegistered(SCOPE)
    const [key] = mocks.set.mock.calls[0] ?? []
    mocks.getSync.mockImplementation((k) => (k === key ? '1' : null))

    expect(isIdentityRegistered({...SCOPE, network: 'mainnet'})).toBe(false)
  })

  it('misses on a different identity', async () => {
    await markIdentityRegistered(SCOPE)
    const [key] = mocks.set.mock.calls[0] ?? []
    mocks.getSync.mockImplementation((k) => (k === key ? '1' : null))

    expect(isIdentityRegistered({...SCOPE, identity: 'pnyx_id1somebodyelse'})).toBe(false)
  })

  it('reads any value other than the marker as unregistered', () => {
    for (const stored of [null, '', '0', 'true', 'yes']) {
      mocks.getSync.mockReturnValue(stored)
      expect(isIdentityRegistered(SCOPE)).toBe(false)
    }
  })

  it('reports unregistered when storage throws, rather than propagating', () => {
    mocks.getSync.mockImplementation(() => {
      throw new Error('mmkv unavailable')
    })

    // A false negative costs one slow login; letting this throw would fail the sign-in outright.
    expect(isIdentityRegistered(SCOPE)).toBe(false)
    expect(mocks.warn).toHaveBeenCalled()
  })

  it('swallows write and clear failures — the cache must never fail a sign-in', async () => {
    mocks.set.mockRejectedValue(new Error('disk full'))
    mocks.remove.mockRejectedValue(new Error('disk full'))

    await expect(markIdentityRegistered(SCOPE)).resolves.toBeUndefined()
    await expect(clearIdentityRegistered(SCOPE)).resolves.toBeUndefined()
    expect(mocks.warn).toHaveBeenCalledTimes(2)
  })

  it('clears the same key it marked', async () => {
    await markIdentityRegistered(SCOPE)
    await clearIdentityRegistered(SCOPE)

    expect(mocks.remove.mock.calls[0]?.[0]).toBe(mocks.set.mock.calls[0]?.[0])
  })
})
