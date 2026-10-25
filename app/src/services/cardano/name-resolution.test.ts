import {Bech32} from '@evolution-sdk/review/Brands'
import {Address} from '@pnyx/cardano-core'
import {Effect} from 'effect'
import {afterEach, describe, expect, it, vi} from 'vitest'
import type {CardanoRailConfig} from './config'
import {
  CACHEABLE_NAME_ERROR_KINDS,
  clearNameCache,
  type NameResolutionError,
  nameCacheEntryFresh,
  resolveRecipient,
} from './name-resolution'
import type {CardanoRail} from './rail'

const MAINNET_ADDR =
  'addr1qy8ac7qqy0vtulyl7wntmsxc6wex80gvcyjy33qffrhm7sh927ysx5sftuw0dlft05dz3c7revpf7jx0xnlcjz3g69mq4afdhv'

const railWith = (network: CardanoRailConfig['network']): CardanoRail =>
  ({
    config: {
      network,
      networkId: network === 'mainnet' ? 1 : 0,
      protocolMagic: network === 'mainnet' ? 764824073 : 1,
      koiosUrl: 'https://fp.example/koios',
    },
  }) as unknown as CardanoRail

const stubFetch = (impl: (url: string, init?: RequestInit) => unknown) =>
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) =>
    Promise.resolve(impl(url, init)).then((body) => ({
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    })),
  )

afterEach(() => {
  vi.unstubAllGlobals()
  clearNameCache()
})

const run = <A, E>(eff: Effect.Effect<A, E>) => Effect.runPromise(Effect.either(eff))

describe('resolveRecipient — CNS (.ada)', () => {
  it('resolves a name.ada to its address via the CNS resolver', async () => {
    let calledUrl = ''
    stubFetch((url, init) => {
      calledUrl = url
      const body = JSON.parse((init?.body as string) ?? '{}')
      expect(body.domain).toBe('alice.ada')
      expect(body.cnsPolicyId).toMatch(/^[0-9a-f]{56}$/)
      return {address: MAINNET_ADDR, expired: false}
    })
    const res = await run(resolveRecipient('Alice.ADA', railWith('mainnet')))
    expect(res._tag).toBe('Right')
    if (res._tag !== 'Right') return
    expect(res.right.name).toBe('alice.ada')
    expect(res.right.addressHex).toBe(Address.fromBech32Sync(Bech32(MAINNET_ADDR)))
    expect(calledUrl).toContain('cardanoname.service')
  })

  it('fails cns-expired for an expired name', async () => {
    stubFetch(() => ({address: MAINNET_ADDR, expired: true}))
    const res = await run(resolveRecipient('bob.ada', railWith('mainnet')))
    expect(res._tag).toBe('Left')
    if (res._tag !== 'Left') return
    expect((res.left as NameResolutionError).kind).toBe('cns-expired')
  })

  it('fails cns-not-found for an unregistered name', async () => {
    stubFetch(() => ({address: null, expired: false}))
    const res = await run(resolveRecipient('nope.ada', railWith('mainnet')))
    expect(res._tag).toBe('Left')
    if (res._tag !== 'Left') return
    expect((res.left as NameResolutionError).kind).toBe('cns-not-found')
  })

  it('is cns-unavailable on non-mainnet without hitting the network', async () => {
    let called = false
    stubFetch(() => {
      called = true
      return {}
    })
    const res = await run(resolveRecipient('alice.ada', railWith('preprod')))
    expect(res._tag).toBe('Left')
    if (res._tag !== 'Left') return
    expect((res.left as NameResolutionError).kind).toBe('cns-unavailable')
    expect(called).toBe(false)
  })

  it('routes a bech32 address straight to address validation (not CNS/handle)', async () => {
    const res = await run(resolveRecipient(MAINNET_ADDR, railWith('mainnet')))
    expect(res._tag).toBe('Right')
    if (res._tag !== 'Right') return
    expect(res.right.name).toBeNull()
    expect(res.right.addressHex).toBe(Address.fromBech32Sync(Bech32(MAINNET_ADDR)))
  })
})

describe('nameCacheEntryFresh', () => {
  const HOUR = 60 * 60_000
  const FIVE_MIN = 5 * 60_000

  it('caches positives for ~1h', () => {
    expect(nameCacheEntryFresh({kind: 'ok', at: 0}, HOUR - 1)).toBe(true)
    expect(nameCacheEntryFresh({kind: 'ok', at: 0}, HOUR)).toBe(false)
  })

  it('caches negatives only ~5min (so a freshly-registered name is not stuck)', () => {
    expect(nameCacheEntryFresh({kind: 'err', at: 0}, FIVE_MIN - 1)).toBe(true)
    expect(nameCacheEntryFresh({kind: 'err', at: 0}, FIVE_MIN)).toBe(false)
  })
})

describe('CACHEABLE_NAME_ERROR_KINDS', () => {
  it('caches definitive negatives, never transient/config failures', () => {
    expect(CACHEABLE_NAME_ERROR_KINDS.has('handle-not-found')).toBe(true)
    expect(CACHEABLE_NAME_ERROR_KINDS.has('cns-not-found')).toBe(true)
    expect(CACHEABLE_NAME_ERROR_KINDS.has('cns-expired')).toBe(true)
    expect(CACHEABLE_NAME_ERROR_KINDS.has('lookup-failed')).toBe(false)
    expect(CACHEABLE_NAME_ERROR_KINDS.has('handle-unavailable')).toBe(false)
    expect(CACHEABLE_NAME_ERROR_KINDS.has('cns-unavailable')).toBe(false)
  })
})
