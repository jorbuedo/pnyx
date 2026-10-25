import {MemoryPricePointTable} from '@pnyx/store/price-point-table.memory'
import {MemoryTokenPricesTable} from '@pnyx/store/token-prices-table.memory'
import {Effect} from 'effect'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {clearPricePointStore, readSeriesRange, setPricePointStore} from '../price-history/price-point-store'
import {tokenAdaSeriesKey} from '../price-history/range'
import {getCardanoAssetsConfig} from './config'
import {clearPriceCache, getAdaFiat, getTokenAdaSpots} from './price-cache'
import {clearCardanoAssetsPriceStore, setCardanoAssetsPriceStore} from './price-store'
import {resetSteelswapBackoff} from './steelswap'
import {isSteelswapAuthUrl, primeSteelswapAuth, steelswapAuthRoute} from './steelswap-auth-stub'
import type {FetchLike} from './token-metadata'

const CONFIG = getCardanoAssetsConfig('mainnet')
const POLICY = 'a'.repeat(56)
const unit = (n: string) => `${POLICY}${n}`

// Counting stub: anon mint always ok; ADA→fiat is Kraken's Ticker, token spots
// are SteelSwap's. `counts.quote` = ADA→fiat (Kraken) calls, `prices` = spots.
const makeFetch = () => {
  const counts = {quote: 0, prices: 0}
  const fetchImpl: FetchLike = (url, init) => {
    if (isSteelswapAuthUrl(url)) return steelswapAuthRoute(url) as Promise<never>

    if (url.includes('/0/public/Ticker')) {
      counts.quote += 1
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({error: [], result: {ADAUSD: {c: ['0.5', '0']}}}),
      })
    }
    if (url.includes('/taptools/token/prices')) {
      counts.prices += 1
      const body = JSON.parse((init?.body ?? '[]') as string) as string[]
      return Promise.resolve({ok: true, status: 200, json: async () => Object.fromEntries(body.map((u) => [u, 2]))})
    }
    return Promise.resolve({ok: false, status: 404, json: async () => ({})})
  }
  return {fetchImpl, counts}
}

beforeEach(() => {
  clearPriceCache()
  primeSteelswapAuth()
  resetSteelswapBackoff()
})

describe('getAdaFiat', () => {
  it('dedupes concurrent calls into one quote request', async () => {
    const {fetchImpl, counts} = makeFetch()
    const [a, b] = await Promise.all([
      getAdaFiat('USD', 1_000, CONFIG, fetchImpl),
      getAdaFiat('USD', 1_000, CONFIG, fetchImpl),
    ])
    expect(a).toBe(0.5)
    expect(b).toBe(0.5)
    expect(counts.quote).toBe(1)
  })

  it('serves the cache within TTL, refetches after it', async () => {
    const {fetchImpl, counts} = makeFetch()
    await getAdaFiat('USD', 1_000, CONFIG, fetchImpl)
    await getAdaFiat('USD', 30_000, CONFIG, fetchImpl) // within 60s TTL
    expect(counts.quote).toBe(1)
    await getAdaFiat('USD', 70_000, CONFIG, fetchImpl) // past TTL
    expect(counts.quote).toBe(2)
  })
})

describe('getTokenAdaSpots', () => {
  it('fetches missing units once and caches per unit across calls', async () => {
    const {fetchImpl, counts} = makeFetch()
    const first = await getTokenAdaSpots([unit('01'), unit('02')], 1_000, CONFIG, fetchImpl)
    expect(first.get(unit('01'))).toBe(2)
    // Second call: unit 01 cached, only unit 03 is missing → one more request.
    await getTokenAdaSpots([unit('01'), unit('03')], 1_000, CONFIG, fetchImpl)
    expect(counts.prices).toBe(2)
  })

  it('spot cache is currency-independent (no refetch when currency changes)', async () => {
    const {fetchImpl, counts} = makeFetch()
    await getTokenAdaSpots([unit('01')], 1_000, CONFIG, fetchImpl)
    await getTokenAdaSpots([unit('01')], 1_000, CONFIG, fetchImpl)
    expect(counts.prices).toBe(1)
  })
})

// Flush the microtask queue + one macrotask so fire-and-forget writes /
// background refetches (both fed by synchronously-resolved stubs) settle.
const flush = () => new Promise<void>((r) => setTimeout(r, 0))

describe('persisted read-through', () => {
  beforeEach(async () => {
    setCardanoAssetsPriceStore(await Effect.runPromise(MemoryTokenPricesTable))
  })
  afterEach(() => {
    clearCardanoAssetsPriceStore()
  })

  it('serves a persisted spot across a RAM-cache wipe without refetching', async () => {
    const {fetchImpl, counts} = makeFetch()
    const first = await getTokenAdaSpots([unit('01')], 1_000, CONFIG, fetchImpl)
    expect(first.get(unit('01'))).toBe(2)
    await flush() // let the fire-and-forget persist land
    clearPriceCache() // simulate a cold boot (RAM gone, SQLite survives)
    const second = await getTokenAdaSpots([unit('01')], 30_000, CONFIG, fetchImpl)
    expect(second.get(unit('01'))).toBe(2)
    expect(counts.prices).toBe(1) // served from the persisted store, no new fetch
  })

  it('serves a persisted ADA→fiat quote across a RAM-cache wipe', async () => {
    const {fetchImpl, counts} = makeFetch()
    expect(await getAdaFiat('USD', 1_000, CONFIG, fetchImpl)).toBe(0.5)
    await flush()
    clearPriceCache()
    expect(await getAdaFiat('USD', 30_000, CONFIG, fetchImpl)).toBe(0.5)
    expect(counts.quote).toBe(1)
  })

  it('a cold boot makes NO request while the persisted price is young enough', async () => {
    // The quota-burn regression: the background refresh used to be gated on the
    // 60s RAM-freshness window, and RAM is empty on every launch — so every app
    // start (or web reload) spent a request. SteelSwap meters a daily quota
    // shared with the swap endpoints, so this is what took swap down.
    const {fetchImpl, counts} = makeFetch()
    await getTokenAdaSpots([unit('01')], 1_000, CONFIG, fetchImpl)
    expect(await getAdaFiat('USD', 1_000, CONFIG, fetchImpl)).toBe(0.5)
    await flush()

    // Ten cold boots, each two minutes after the last fetch — well past RAM
    // freshness, well inside the usable window.
    for (let i = 1; i <= 10; i++) {
      clearPriceCache()
      const at = 1_000 + 120_000
      expect((await getTokenAdaSpots([unit('01')], at, CONFIG, fetchImpl)).get(unit('01'))).toBe(2)
      expect(await getAdaFiat('USD', at, CONFIG, fetchImpl)).toBe(0.5)
      await flush()
    }
    expect(counts.prices).toBe(1)
    expect(counts.quote).toBe(1)
  })

  it('refetches a persisted spot once it is past the persisted window', async () => {
    const {fetchImpl, counts} = makeFetch()
    await getTokenAdaSpots([unit('01')], 1_000, CONFIG, fetchImpl)
    await flush()
    clearPriceCache()
    // 1_000 + 600_000 window exceeded → the persisted value is too old to serve.
    await getTokenAdaSpots([unit('01')], 700_000, CONFIG, fetchImpl)
    expect(counts.prices).toBe(2)
  })

  it('serves a stale-but-usable persisted spot immediately and refreshes in the background', async () => {
    const {fetchImpl, counts} = makeFetch()
    await getTokenAdaSpots([unit('01')], 1_000, CONFIG, fetchImpl)
    await flush()
    clearPriceCache()
    // Past REFRESH_MS (5 min) but within the 600s persisted window: the value is
    // served from the store, and one refresh is spent to converge before it
    // stops being usable. Note this used to trigger at 60s — see the cold-boot
    // test above for why that mattered.
    const got = await getTokenAdaSpots([unit('01')], 1_000 + 360_000, CONFIG, fetchImpl)
    expect(got.get(unit('01'))).toBe(2)
    await flush()
    expect(counts.prices).toBe(2) // the background refresh ran
  })
})

describe('a rate-limited upstream', () => {
  // Without a bound store there is nothing persisted to fall back to, and every
  // assertion below would pass vacuously.
  beforeEach(async () => {
    setCardanoAssetsPriceStore(await Effect.runPromise(MemoryTokenPricesTable))
  })
  afterEach(() => {
    clearCardanoAssetsPriceStore()
  })

  // The failure this covers: a 429 blanked every token's fiat, so a priced
  // holding silently dropped out of the portfolio total. The spot was already
  // on disk — refusing to read it did not make the total more truthful.
  const throttled = (retryAfterSec: string) => {
    const counts = {prices: 0}
    const fetchImpl: FetchLike = (url, init) => {
      if (isSteelswapAuthUrl(url)) return steelswapAuthRoute(url) as Promise<never>

      if (url.includes('/taptools/token/prices')) {
        counts.prices += 1
        if (counts.prices === 1) {
          const body = JSON.parse((init?.body ?? '[]') as string) as string[]
          return Promise.resolve({ok: true, status: 200, json: async () => Object.fromEntries(body.map((u) => [u, 2]))})
        }
        return Promise.resolve({
          ok: false,
          status: 429,
          headers: {get: (n: string) => (n === 'retry-after' ? retryAfterSec : null)},
          json: async () => ({detail: 'Too Many Requests'}),
        })
      }
      return Promise.resolve({ok: false, status: 404, json: async () => ({})})
    }
    return {fetchImpl, counts}
  }

  it('keeps serving a spot that is far past the normal window while parked on a 429', async () => {
    const {fetchImpl} = throttled('3600') // parks until 700_000 + 1h
    await getTokenAdaSpots([unit('01')], 1_000, CONFIG, fetchImpl)
    await flush()
    clearPriceCache()
    await getTokenAdaSpots([unit('02')], 700_000, CONFIG, fetchImpl) // trips the 429
    await flush()
    clearPriceCache()
    // 50 minutes: well past PERSIST_MS (10 min), still inside the backoff.
    const got = await getTokenAdaSpots([unit('01')], 3_000_000, CONFIG, fetchImpl)
    expect(got.get(unit('01'))).toBe(2)
  })

  it('still expires a spot old enough that even a throttled wallet should not show it', async () => {
    const {fetchImpl} = throttled('21600') // 6h, the clamp
    await getTokenAdaSpots([unit('01')], 1_000, CONFIG, fetchImpl)
    await flush()
    clearPriceCache()
    // Trip the 429 at 20h, so the backoff is still live at 25h.
    await getTokenAdaSpots([unit('02')], 20 * 3600_000, CONFIG, fetchImpl)
    await flush()
    clearPriceCache()
    // 25h old: past PERSIST_BACKOFF_MS even though the upstream is still parked.
    // Absence is reported rather than a price nobody should act on.
    const got = await getTokenAdaSpots([unit('01')], 25 * 3600_000, CONFIG, fetchImpl)
    expect(got.get(unit('01'))).toBeUndefined()
  })

  it('recovers on the very first pass of a session, when the fetch itself trips the backoff', async () => {
    // The persisted read happens before the fetch, so it used the narrow window
    // and found nothing usable. Re-checking after the 429 is what keeps a cold
    // start from blanking every holding until something re-queries.
    const {fetchImpl} = throttled('3600')
    await getTokenAdaSpots([unit('01')], 1_000, CONFIG, fetchImpl)
    await flush()
    clearPriceCache()
    resetSteelswapBackoff() // as after a reload: nothing knows the quota is spent
    // 50 minutes later — past PERSIST_MS, so the pre-fetch read declines it, the
    // fetch 429s, and only the post-fetch re-check can save the row.
    const got = await getTokenAdaSpots([unit('01')], 3_000_000, CONFIG, fetchImpl)
    expect(got.get(unit('01'))).toBe(2)
  })

  it('goes back to live prices once the upstream recovers, rather than serving the stale one', async () => {
    // The stale value is a stopgap, not a new resting state: as soon as a fetch
    // succeeds the fresh number must win.
    let calls = 0
    const recovering: FetchLike = (url, init) => {
      if (isSteelswapAuthUrl(url)) return steelswapAuthRoute(url) as Promise<never>

      calls += 1
      if (calls === 2) {
        return Promise.resolve({
          ok: false,
          status: 429,
          headers: {get: () => '60'},
          json: async () => ({}),
        })
      }
      const body = JSON.parse((init?.body ?? '[]') as string) as string[]
      const price = calls === 1 ? 2 : 7
      return Promise.resolve({ok: true, status: 200, json: async () => Object.fromEntries(body.map((u) => [u, price]))})
    }
    await getTokenAdaSpots([unit('01')], 1_000, CONFIG, recovering)
    await flush()
    clearPriceCache()
    await getTokenAdaSpots([unit('02')], 700_000, CONFIG, recovering) // 429, parks until 760_000
    await flush()
    clearPriceCache()
    const got = await getTokenAdaSpots([unit('01')], 900_000, CONFIG, recovering)
    expect(got.get(unit('01'))).toBe(7)
  })
})

describe('token→ADA history self-seeding', () => {
  // The resilience fallback reads the token→ADA series. That series used to be
  // written only by the chart's OHLCV call — the same host that gets throttled —
  // so on a first rate-limit there was nothing to fall back to, which is exactly
  // when it is needed. Every cheap spot fetch now seeds it.
  beforeEach(async () => {
    setCardanoAssetsPriceStore(await Effect.runPromise(MemoryTokenPricesTable))
    setPricePointStore(await Effect.runPromise(MemoryPricePointTable))
  })
  afterEach(() => {
    clearCardanoAssetsPriceStore()
    clearPricePointStore()
  })

  it('writes a price point for every unit a live spot resolved', async () => {
    const {fetchImpl} = makeFetch()
    const nowMs = 1_000_000
    await getTokenAdaSpots([unit('01'), unit('02')], nowMs, CONFIG, fetchImpl)
    await flush()
    for (const u of [unit('01'), unit('02')]) {
      const rows = await readSeriesRange(CONFIG.network, tokenAdaSeriesKey(u), 0, Math.floor(nowMs / 1000))
      expect(
        rows.map((r) => r.value),
        u,
      ).toEqual([2])
    }
  })

  it('seeds nothing for a unit the upstream did not price', async () => {
    // Absence must stay absent: a seeded point would become a fallback value
    // for a token we never had a price for.
    const fetchImpl: FetchLike = (url) =>
      isSteelswapAuthUrl(url)
        ? (steelswapAuthRoute(url) as Promise<never>)
        : Promise.resolve({ok: true, status: 200, json: async () => ({})})
    await getTokenAdaSpots([unit('09')], 1_000_000, CONFIG, fetchImpl)
    await flush()
    const rows = await readSeriesRange(CONFIG.network, tokenAdaSeriesKey(unit('09')), 0, 1_000)
    expect(rows).toEqual([])
  })

  it('gives the throttled fallback something to read', async () => {
    // End to end: a spot fetched today survives a 429 tomorrow via the series,
    // even after the persisted spot itself has aged out.
    const {fetchImpl} = makeFetch()
    await getTokenAdaSpots([unit('01')], 1_000, CONFIG, fetchImpl)
    await flush()
    clearPriceCache()
    clearCardanoAssetsPriceStore() // the spot row is gone; only the series remains
    const dead: FetchLike = (url) =>
      isSteelswapAuthUrl(url)
        ? (steelswapAuthRoute(url) as Promise<never>)
        : Promise.resolve({ok: false, status: 429, headers: {get: () => '3600'}, json: async () => ({})})
    const got = await getTokenAdaSpots([unit('01')], 2_000, CONFIG, dead)
    expect(got.get(unit('01'))).toBe(2)
  })
})
