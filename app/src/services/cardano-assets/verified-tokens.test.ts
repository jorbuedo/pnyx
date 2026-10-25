import {beforeEach, describe, expect, it, vi} from 'vitest'
import {primeSteelswapAuth, steelswapAuthRoute} from './steelswap-auth-stub'
import type {FetchLike} from './token-metadata'

// In-memory storage stub (avoids loading the real MMKV/localStorage module).
const mem = new Map<string, string>()
vi.mock('../../platform/storage', () => ({
  storage: {
    getSync: (k: string) => mem.get(k) ?? null,
    get: async (k: string) => mem.get(k) ?? null,
    set: async (k: string, v: string) => {
      mem.set(k, v)
    },
  },
}))

import {getVerifiedTokens, isVerifiedId, readVerifiedTokensSync, resetVerifiedTokensCache} from './verified-tokens'

const KEY = '@pnyx/cardano_verified_tokens'
const POLICY = 'a'.repeat(56)
const SNEK_UNIT = `${POLICY}534e454b`
const SNEK_ID = `${POLICY}.534e454b`
/** A `GET /api/v2/tokens/list` row. */
const SNEK_ROW = {
  token: {
    unit: SNEK_UNIT,
    policyId: POLICY,
    assetName: '534e454b',
    ticker: 'SNEK',
    name: 'Snek',
    decimals: 0,
    decimalsKnown: true,
  },
  verified: true,
  liquidityAda: 1_000,
}

/** Serve the CIP-8 mint, then one page of the ranked token list. */
const stubFetch =
  (rows: readonly unknown[]): FetchLike =>
  (url) => {
    const auth = steelswapAuthRoute(url)
    if (auth !== null) return auth as ReturnType<FetchLike>
    return Promise.resolve({
      ok: true,
      status: 200,
      // No cursor → one page, so the walk terminates.
      json: async () => ({items: rows}),
    }) as unknown as ReturnType<FetchLike>
  }

beforeEach(() => {
  mem.clear()
  resetVerifiedTokensCache()
  primeSteelswapAuth()
})

describe('verified-tokens', () => {
  it('fetches, persists, and exposes verifiedIds (ADA always verified)', async () => {
    const v = await getVerifiedTokens(1000, stubFetch([SNEK_ROW]))
    expect(v.tokens).toHaveLength(1)
    expect(v.verifiedIds.has(SNEK_ID)).toBe(true)
    expect(isVerifiedId(v.verifiedIds, '')).toBe(true) // ADA ''
    expect(isVerifiedId(v.verifiedIds, '.')).toBe(true) // ADA '.'
    expect(isVerifiedId(v.verifiedIds, 'p.unlisted')).toBe(false)
    expect(mem.get(KEY)).toBeDefined() // persisted
  })

  it('serves the persisted cache when fresh — no refetch', async () => {
    mem.set(KEY, JSON.stringify({fetchedAt: 1000, tokens: [{assetId: 'p.x', ticker: 'X', name: 'X', decimals: 0}]}))
    let fetched = false
    const spy: FetchLike = () => {
      fetched = true
      return Promise.resolve({ok: true, status: 200, json: async () => []}) as unknown as ReturnType<FetchLike>
    }
    const v = await getVerifiedTokens(1000 + 60_000, spy) // well within the 24h TTL
    expect(fetched).toBe(false)
    expect(v.verifiedIds.has('p.x')).toBe(true)
    expect(readVerifiedTokensSync()?.verifiedIds.has('p.x')).toBe(true)
  })

  it('refetches when the cache is stale', async () => {
    mem.set(KEY, JSON.stringify({fetchedAt: 0, tokens: [{assetId: 'p.old', ticker: 'OLD', name: 'Old', decimals: 0}]}))
    const v = await getVerifiedTokens(25 * 60 * 60 * 1000, stubFetch([SNEK_ROW])) // > 24h later
    expect(v.verifiedIds.has('p.old')).toBe(false)
    expect(v.verifiedIds.has(SNEK_ID)).toBe(true)
  })

  it('falls back to the stale cache when the fetch fails', async () => {
    mem.set(KEY, JSON.stringify({fetchedAt: 0, tokens: [{assetId: 'p.old', ticker: 'OLD', name: 'Old', decimals: 0}]}))
    const failing: FetchLike = () =>
      Promise.resolve({ok: false, status: 503, json: async () => ({})}) as unknown as ReturnType<FetchLike>
    const v = await getVerifiedTokens(25 * 60 * 60 * 1000, failing)
    expect(v.verifiedIds.has('p.old')).toBe(true) // kept stale rather than wiped
  })
})
