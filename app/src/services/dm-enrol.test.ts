import {encodePnyxId} from '@pnyx/contract-client/identity'
import {Effect} from 'effect'
import {beforeEach, describe, expect, it, vi} from 'vitest'

const backing = new Map<string, string>()
vi.mock('../platform/storage', () => ({
  storage: {
    get: async (key: string) => backing.get(key) ?? null,
    set: async (key: string, value: string) => {
      backing.set(key, String(value))
    },
    remove: async (key: string) => {
      backing.delete(key)
    },
    getSync: (key: string) => backing.get(key) ?? null,
  },
}))

const api = {
  availableKeyPackages: vi.fn(),
  publishKeyPackages: vi.fn(),
  retireAllKeyPackages: vi.fn(),
}
vi.mock('./dm-api', async () => {
  const actual = await vi.importActual<typeof import('./dm-api')>('./dm-api')
  return {...actual, dmApi: api}
})

const {ensureKeyPackagePool} = await import('./dm-enrol')
const {decodeMlsKeyPackage} = await import('./dm-mls')

const run = <A, E>(e: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(e as Effect.Effect<A, never>)

const ROOT = new Uint8Array(32).fill(3)
const SELF_ID = encodePnyxId(new Uint8Array(32).fill(0x61))
const input = () => ({
  token: 'tok',
  selfIdentity: SELF_ID,
  forumRoot: ROOT,
  network: 'mainnet',
})

beforeEach(() => {
  backing.clear()
  for (const fn of Object.values(api)) fn.mockReset()
})

describe('ensureKeyPackagePool', () => {
  it('does nothing while the pool is healthy', async () => {
    // ⚠️ The halves matter to the assertion, not just the count. A device holding none while the
    // server reports a pool is a *reset*, not a healthy device — see the test below — so a fixture
    // that seeded only the count was asserting a state production cannot reach.
    backing.set('@pnyx/dm/kp-index', 'aa,bb,cc')
    api.availableKeyPackages.mockResolvedValue(12)
    expect(await ensureKeyPackagePool(input())).toBe(0)
    expect(api.publishKeyPackages).not.toHaveBeenCalled()
    expect(api.retireAllKeyPackages).not.toHaveBeenCalled()
  })

  /**
   * The failure this exists to stop: the public halves survive a storage reset, so the pool looks
   * healthy, nothing republishes, and every peer who claims one seals a Welcome to a package that
   * can never be opened — an invite that dies on arrival, silently, on *their* side.
   */
  it('retires and republishes when it holds no private half for a pool the server reports', async () => {
    api.availableKeyPackages.mockResolvedValue(20)
    api.retireAllKeyPackages.mockResolvedValue({retired: 20, available: 0})
    api.publishKeyPackages.mockImplementation(async (_token: string, packages: readonly Uint8Array[]) => ({
      added: packages.length,
      available: packages.length,
    }))

    expect(await ensureKeyPackagePool(input())).toBe(20)
    expect(api.retireAllKeyPackages).toHaveBeenCalledOnce()
    const storedHalves = [...backing.keys()].filter((k) => k.startsWith('@pnyx/dm/kp/'))
    expect(storedHalves).toHaveLength(20)
  })

  // A device that has simply never published must not be mistaken for a reset one.
  it('does not retire when there is no pool to retire', async () => {
    api.availableKeyPackages.mockResolvedValue(0)
    api.publishKeyPackages.mockResolvedValue({added: 20, available: 20})
    await ensureKeyPackagePool(input())
    expect(api.retireAllKeyPackages).not.toHaveBeenCalled()
  })

  it('refills to the target and stores a private half for every package published', async () => {
    // The invariant that matters: a published package with no stored private half is a group we
    // could be added to and never join.
    api.availableKeyPackages.mockResolvedValue(0)
    api.publishKeyPackages.mockImplementation(async (_token: string, packages: readonly Uint8Array[]) => ({
      added: packages.length,
      available: packages.length,
    }))
    const added = await ensureKeyPackagePool(input())
    expect(added).toBe(20)
    const published = api.publishKeyPackages.mock.calls[0]?.[1] as readonly Uint8Array[]
    const storedHalves = [...backing.keys()].filter((k) => k.startsWith('@pnyx/dm/kp/'))
    expect(storedHalves).toHaveLength(published.length)
  })

  // The credential is what a peer checks against the id they addressed
  // (`verifyKeyPackageAnchor` binding 2). Publishing packages credentialled to anything else — an
  // `mn_addr`, as this did before the identity migration — makes every incoming conversation fail
  // as `key-package-rejected`.
  it('credentials every package to our pnyx_id', async () => {
    api.availableKeyPackages.mockResolvedValue(0)
    api.publishKeyPackages.mockImplementation(async (_token: string, packages: readonly Uint8Array[]) => ({
      added: packages.length,
      available: packages.length,
    }))
    await ensureKeyPackagePool(input())
    const published = api.publishKeyPackages.mock.calls[0]?.[1] as readonly Uint8Array[]
    const first = published[0] as Uint8Array
    const kp = await run(decodeMlsKeyPackage(first))
    const credential = kp.leafNode.credential
    expect(credential.credentialType).toBe('basic')
    if (credential.credentialType !== 'basic') return
    expect(new TextDecoder().decode(credential.identity)).toBe(SELF_ID)
  })
})
