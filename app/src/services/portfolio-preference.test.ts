import {beforeEach, describe, expect, it, vi} from 'vitest'

const backing = new Map<string, string>()
let syncSupported = true
let failWrites = false

vi.mock('../platform/storage', () => ({
  get storageSupportsSyncGet() {
    return syncSupported
  },
  storage: {
    get: async (key: string) => backing.get(key) ?? null,
    set: async (key: string, value: string) => {
      if (failWrites) throw new Error('storage full')
      backing.set(key, String(value))
    },
    getSync: (key: string) => backing.get(key) ?? null,
  },
}))

vi.mock('../logger', () => ({logger: {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}}))

const load = async () => {
  vi.resetModules()
  return import('./portfolio-preference')
}

beforeEach(() => {
  backing.clear()
  syncSupported = true
  failWrites = false
})

describe('the unverified-token filter', () => {
  it('hides unverified tokens until it is turned off', async () => {
    const pref = await load()
    expect(pref.getShowUnverifiedSnapshot()).toBe(false)
    await pref.setShowUnverified(true)
    expect(pref.getShowUnverifiedSnapshot()).toBe(true)
    expect(backing.get(pref.SHOW_UNVERIFIED_KEY)).toBe('true')
  })

  it('survives a remount — the whole point of storing it', async () => {
    const first = await load()
    await first.setShowUnverified(true)
    const remounted = await load()
    expect(remounted.getShowUnverifiedSnapshot()).toBe(true)
  })

  it('tells every subscriber, so a second tab does not keep the old rule', async () => {
    const pref = await load()
    const a = vi.fn()
    const b = vi.fn()
    const unsubscribe = pref.subscribeShowUnverified(a)
    pref.subscribeShowUnverified(b)
    await pref.setShowUnverified(true)
    expect(a).toHaveBeenCalled()
    expect(b).toHaveBeenCalled()
    unsubscribe()
    a.mockClear()
    await pref.setShowUnverified(false)
    expect(a).not.toHaveBeenCalled()
    expect(b).toHaveBeenCalledTimes(2)
  })

  it('leaves the filter where it was when the write fails', async () => {
    const pref = await load()
    failWrites = true
    const listener = vi.fn()
    pref.subscribeShowUnverified(listener)
    await pref.setShowUnverified(true)
    expect(pref.getShowUnverifiedSnapshot()).toBe(false)
    expect(listener).not.toHaveBeenCalled()
  })

  it('hydrates asynchronously where storage has no synchronous read', async () => {
    syncSupported = false
    backing.set('@pnyx/portfolio/show-unverified', 'true')
    const pref = await load()
    expect(pref.getShowUnverifiedSnapshot()).toBe(false)
    const listener = vi.fn()
    pref.subscribeShowUnverified(listener)
    await vi.waitFor(() => expect(listener).toHaveBeenCalled())
    expect(pref.getShowUnverifiedSnapshot()).toBe(true)
  })
})
