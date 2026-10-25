import {beforeEach, describe, expect, it, vi} from 'vitest'

const mocks = vi.hoisted(() => ({
  store: new Map<string, string>(),
  getImpl: null as null | ((key: string) => Promise<string | null>),
}))

// The installation id is device-global — the same value in every profile — so
// it reads `deviceStorage`, not the profile-scoped `storage`. Mocking the wrong
// one here would leave the module reading `undefined` and every assertion would
// fail on a null, which is exactly what happened when the split landed.
const fakeStorage = {
  get: vi.fn((key: string) => (mocks.getImpl ? mocks.getImpl(key) : Promise.resolve(mocks.store.get(key) ?? null))),
  set: vi.fn((key: string, value: string) => {
    mocks.store.set(key, value)
    return Promise.resolve()
  }),
}

vi.mock('./storage', () => ({storage: fakeStorage, deviceStorage: fakeStorage}))

vi.mock('../logger', () => ({logger: {error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn()}}))

const KEY = '@pnyx/installation-id'

// Module-level cache lives in installation-id.ts; reset modules so each test
// starts from a fresh, un-minted state.
const freshModule = async () => {
  vi.resetModules()
  return import('./installation-id')
}

beforeEach(() => {
  mocks.store.clear()
  mocks.getImpl = null
})

describe('getOrCreateInstallationId', () => {
  it('mints, persists, and returns the same id on repeat calls', async () => {
    const {getOrCreateInstallationId} = await freshModule()
    const first = await getOrCreateInstallationId()
    const second = await getOrCreateInstallationId()
    expect(first).toBe(second)
    expect(mocks.store.get(KEY)).toBe(first)
  })

  it('honours an already-persisted id without overwriting it', async () => {
    const {getOrCreateInstallationId} = await freshModule()
    mocks.store.set(KEY, 'existing-id')
    expect(await getOrCreateInstallationId()).toBe('existing-id')
  })

  it('collapses concurrent first-launch callers onto a single id', async () => {
    const {getOrCreateInstallationId} = await freshModule()
    const [a, b] = await Promise.all([getOrCreateInstallationId(), getOrCreateInstallationId()])
    expect(a).toBe(b)
  })

  it('keeps the same id when the first read fails and a later call succeeds', async () => {
    const {getOrCreateInstallationId} = await freshModule()

    // First launch: storage read throws → stable in-memory id, nothing persisted yet.
    mocks.getImpl = () => Promise.reject(new Error('storage locked'))
    const first = await getOrCreateInstallationId()
    expect(first).toBeTruthy()
    expect(mocks.store.get(KEY)).toBeUndefined()

    // Storage recovers: the next call must persist the SAME id (so analytics
    // identify / feature flags / claims stay joined), not mint a fresh one.
    mocks.getImpl = null
    const second = await getOrCreateInstallationId()
    expect(second).toBe(first)
    expect(mocks.store.get(KEY)).toBe(first)
  })
})
