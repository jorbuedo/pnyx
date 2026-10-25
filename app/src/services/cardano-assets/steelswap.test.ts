import {Effect} from 'effect'
import {beforeEach, describe, expect, it} from 'vitest'
import {getCardanoAssetsConfig} from './config'
import {
  fetchMetadata,
  fetchTokenAdaOhlcv,
  fetchTokenAdaPrices,
  resetOhlcvCache,
  resetSteelswapBackoff,
  steelswapAuthedJson,
  tokenIconUrl,
} from './steelswap'
import {isSteelswapAuthUrl, primeSteelswapAuth, steelswapAuthRoute} from './steelswap-auth-stub'
import type {FetchLike} from './token-metadata'

const CONFIG = getCardanoAssetsConfig('mainnet')
const run = <A, E>(e: Effect.Effect<A, E>) => Effect.runPromise(e)
const POLICY = 'a'.repeat(56)
const unit = (n: string) => `${POLICY}${n}`

beforeEach(() => primeSteelswapAuth())

describe('tokenIconUrl', () => {
  it('builds the keyless icon URL', () => {
    expect(tokenIconUrl(unit('01'), CONFIG)).toBe(`${CONFIG.steelswapUrl}/tokens/icon/${unit('01')}/`)
  })
  it('is null for the empty (ADA) unit', () => {
    expect(tokenIconUrl('', CONFIG)).toBeNull()
  })
})

describe('fetchMetadata', () => {
  it('re-mints the anon key and retries once on a 401', async () => {
    let mintCalls = 0
    let metaCalls = 0
    const fetchImpl: FetchLike = (url) => {
      if (isSteelswapAuthUrl(url)) {
        if (url.includes('/auth/keys')) mintCalls += 1
        return steelswapAuthRoute(url) as Promise<never>
      }
      metaCalls += 1
      // First authed attempt 401s (stale key); the retry succeeds.
      if (metaCalls === 1) return Promise.resolve({ok: false, status: 401, json: async () => ({})})
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({tokens: [{unit: unit('01'), decimals: 6, decimalsKnown: true, ticker: 'AAA', name: 'A'}]}),
      })
    }
    const out = await run(fetchMetadata([unit('01')], CONFIG, 1_000, fetchImpl))
    expect(mintCalls).toBe(2) // initial + forced re-mint after the 401
    expect(out.get(unit('01'))).toMatchObject({decimals: 6, ticker: 'AAA'})
  })

  it('reports unknown decimals as null (never fabricated)', async () => {
    const fetchImpl: FetchLike = (url) =>
      isSteelswapAuthUrl(url)
        ? (steelswapAuthRoute(url) as Promise<never>)
        : Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({tokens: [{unit: unit('02'), decimals: 0, decimalsKnown: false, ticker: 'B'}]}),
          })
    const out = await run(fetchMetadata([unit('02')], CONFIG, 1_000, fetchImpl))
    expect(out.get(unit('02'))).toMatchObject({decimals: null, ticker: 'B', name: null})
  })
})

describe('fetchTokenAdaPrices', () => {
  it('chunks unit batches at 100 per request', async () => {
    const units = Array.from({length: 150}, (_, i) => unit(i.toString(16).padStart(4, '0')))
    let priceCalls = 0
    const seen: number[] = []
    const fetchImpl: FetchLike = (url, init) => {
      if (isSteelswapAuthUrl(url)) return steelswapAuthRoute(url) as Promise<never>

      priceCalls += 1
      const body = JSON.parse((init?.body ?? '[]') as string) as string[]
      seen.push(body.length)
      return Promise.resolve({ok: true, status: 200, json: async () => Object.fromEntries(body.map((u) => [u, 1]))})
    }
    const out = await run(fetchTokenAdaPrices(units, CONFIG, 1_000, fetchImpl))
    expect(priceCalls).toBe(2)
    expect(seen).toEqual([100, 50])
    expect(out.size).toBe(150)
  })
})

describe('fetchTokenAdaOhlcv', () => {
  const anonOk: ReturnType<FetchLike> = Promise.resolve({
    ok: true,
    status: 201,
    json: async () => ({api_key: 'k', expires_at: '2099-01-01T00:00:00Z'}),
  })

  it('maps candle rows to ascending {ts, close} points', async () => {
    const fetchImpl: FetchLike = (url) => {
      if (isSteelswapAuthUrl(url)) return steelswapAuthRoute(url) as Promise<never>
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => [
          {time: 2000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 9},
          {time: 1000, open: 1, high: 1, low: 1, close: 1.1, volume: 3},
        ],
      })
    }
    const out = await run(fetchTokenAdaOhlcv(unit('01'), '1d', 2, CONFIG, 1_000, fetchImpl))
    expect(out).toEqual([
      {ts: 1000, value: 1.1},
      {ts: 2000, value: 1.5},
    ])
  })

  // ⚠️ There was no cache at all: the same 365 daily candles for the same token went out
  // ~65 times in one session, identical query string every time.
  it('serves a repeat within the window without asking again', async () => {
    resetOhlcvCache()
    let calls = 0
    const fetchImpl: FetchLike = (url) => {
      if (isSteelswapAuthUrl(url)) return steelswapAuthRoute(url) as Promise<never>
      calls += 1
      return Promise.resolve({ok: true, status: 200, json: async () => [{time: 1000, close: 2}]})
    }
    const first = await run(fetchTokenAdaOhlcv(unit('02'), '1d', 365, CONFIG, 1_000, fetchImpl))
    const second = await run(fetchTokenAdaOhlcv(unit('02'), '1d', 365, CONFIG, 60_000, fetchImpl))
    expect(second).toEqual(first)
    expect(calls).toBe(1)
  })

  it('asks again once the window has passed', async () => {
    resetOhlcvCache()
    let calls = 0
    const fetchImpl: FetchLike = (url) => {
      if (isSteelswapAuthUrl(url)) return steelswapAuthRoute(url) as Promise<never>
      calls += 1
      return Promise.resolve({ok: true, status: 200, json: async () => [{time: 1000, close: 2}]})
    }
    await run(fetchTokenAdaOhlcv(unit('03'), '1d', 365, CONFIG, 1_000, fetchImpl))
    await run(fetchTokenAdaOhlcv(unit('03'), '1d', 365, CONFIG, 1_000 + 6 * 60_000, fetchImpl))
    expect(calls).toBe(2)
  })

  it('keeps series apart by unit, interval and count', async () => {
    resetOhlcvCache()
    let calls = 0
    const fetchImpl: FetchLike = (url) => {
      if (isSteelswapAuthUrl(url)) return steelswapAuthRoute(url) as Promise<never>
      calls += 1
      return Promise.resolve({ok: true, status: 200, json: async () => [{time: 1000, close: 2}]})
    }
    await run(fetchTokenAdaOhlcv(unit('04'), '1d', 365, CONFIG, 1_000, fetchImpl))
    await run(fetchTokenAdaOhlcv(unit('05'), '1d', 365, CONFIG, 1_000, fetchImpl))
    await run(fetchTokenAdaOhlcv(unit('04'), '1h', 365, CONFIG, 1_000, fetchImpl))
    await run(fetchTokenAdaOhlcv(unit('04'), '1d', 30, CONFIG, 1_000, fetchImpl))
    expect(calls).toBe(4)
  })

  // "No candles for this token" is a real answer, and re-asking for it every render is
  // exactly the waste this exists to stop.
  it('caches an empty series too', async () => {
    resetOhlcvCache()
    let calls = 0
    const fetchImpl: FetchLike = (url) => {
      if (isSteelswapAuthUrl(url)) return steelswapAuthRoute(url) as Promise<never>
      calls += 1
      return Promise.resolve({ok: true, status: 200, json: async () => []})
    }
    expect(await run(fetchTokenAdaOhlcv(unit('06'), '1d', 365, CONFIG, 1_000, fetchImpl))).toEqual([])
    expect(await run(fetchTokenAdaOhlcv(unit('06'), '1d', 365, CONFIG, 2_000, fetchImpl))).toEqual([])
    expect(calls).toBe(1)
  })

  it('returns empty for the ADA (empty) unit without a request', async () => {
    let calls = 0
    const fetchImpl: FetchLike = () => {
      calls += 1
      return anonOk
    }
    expect(await run(fetchTokenAdaOhlcv('', '1d', 10, CONFIG, 1_000, fetchImpl))).toEqual([])
    expect(calls).toBe(0)
  })
})

describe('429 backoff', () => {
  beforeEach(() => {
    primeSteelswapAuth()
    resetSteelswapBackoff()
  })

  const anonThen429 = () => {
    let calls = 0
    const fetchImpl: FetchLike = (url) => {
      calls += 1
      if (isSteelswapAuthUrl(url)) return steelswapAuthRoute(url) as Promise<never>

      return Promise.resolve({
        ok: false,
        status: 429,
        json: async () => ({detail: 'Too Many Requests'}),
        headers: {get: (n: string) => (n.toLowerCase() === 'retry-after' ? '300' : null)},
      })
    }
    return {fetchImpl, calls: () => calls}
  }

  const priceCall = (fetchImpl: FetchLike, nowMs: number) =>
    run(steelswapAuthedJson(CONFIG, '/api/v2/taptools/token/prices', {method: 'post', body: '[]'}, nowMs, fetchImpl))

  it('parks further calls after a 429 until reset (no network in between)', async () => {
    const {fetchImpl, calls} = anonThen429()
    await expect(priceCall(fetchImpl, 1_000)).rejects.toBeDefined() // mints + 429 → sets backoff
    const afterFirst = calls()
    // Within the backoff window: short-circuits before any fetch.
    await expect(priceCall(fetchImpl, 2_000)).rejects.toBeDefined()
    expect(calls()).toBe(afterFirst)
    // Reset → it tries the network again.
    resetSteelswapBackoff()
    await expect(priceCall(fetchImpl, 3_000)).rejects.toBeDefined()
    expect(calls()).toBeGreaterThan(afterFirst)
  })
})

describe('a 401 under the partner key', () => {
  // The retry exists for a *stale per-install key*. With the partner key there is nothing stale to
  // replace — it is issued out-of-band and the app cannot mint another — so a second attempt would
  // resend the same rejected credential, spend another request against the quota, and report the
  // same 401 one round trip later.
  it('does not re-mint and does not retry', async () => {
    // The 429 backoff is module-shared, and an earlier case in this file parks it.
    resetSteelswapBackoff()
    const PARTNER = {...CONFIG, steelswapPartnerKey: 'partner-key'} as const
    let mintCalls = 0
    let metaCalls = 0
    const seenKeys: string[] = []
    const fetchImpl: FetchLike = (url, init) => {
      if (isSteelswapAuthUrl(url)) {
        if (url.includes('/auth/keys')) mintCalls += 1
        return steelswapAuthRoute(url) as Promise<never>
      }
      metaCalls += 1
      const auth = (init?.headers as Record<string, string> | undefined)?.authorization
      if (auth !== undefined) seenKeys.push(auth)
      return Promise.resolve({ok: false, status: 401, json: async () => ({error: 'unauthorized'})})
    }

    await expect(run(steelswapAuthedJson(PARTNER, '/api/v2/dexes', {}, 1_000, fetchImpl))).rejects.toBeDefined()
    expect(metaCalls, 'the rejected partner key was sent twice').toBe(1)
    expect(mintCalls, 'a CIP-8 mint ran for a key the app cannot replace').toBe(0)
    expect(seenKeys).toEqual(['Bearer partner-key'])
  })
})
