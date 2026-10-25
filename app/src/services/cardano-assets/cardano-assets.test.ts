import {Effect} from 'effect'
import {beforeEach, describe, expect, it} from 'vitest'
import {getCardanoAssetsConfig} from './config'
import {fetchAdaPrice, fetchTokenPrices} from './price'
import {primeSteelswapAuth, steelswapAuthRoute} from './steelswap-auth-stub'
import {displayDecimals, type FetchLike, fetchTokenInfos, unknownTokenInfo} from './token-metadata'

const MAINNET = getCardanoAssetsConfig('mainnet')
const POLICY = 'a'.repeat(56)
// "TEST" in hex → printable; a non-printable name for the hex-truncation path.
const NAME_TEST = Buffer.from('TEST', 'utf8').toString('hex')
const ID_TEST = `${POLICY}.${NAME_TEST}`
const UNIT_TEST = `${POLICY}${NAME_TEST}`
const NAME_BINARY = 'ff00ff00'
const ID_BINARY = `${POLICY}.${NAME_BINARY}`

// Anon key that never expires within the test horizon (nowMs is small).
const stubFetch =
  (routes: Record<string, unknown>, ok = true, status = 200): FetchLike =>
  (url) => {
    // The CIP-8 mint always succeeds here so the authed calls proceed.
    const auth = steelswapAuthRoute(url)
    if (auth !== null) return auth as Promise<never>
    const key = Object.keys(routes).find((k) => url.includes(k))
    return Promise.resolve({
      ok: key !== undefined && ok,
      status: key !== undefined ? status : 404,
      json: async () => (key !== undefined ? routes[key] : {}),
    })
  }

beforeEach(() => primeSteelswapAuth())

describe('displayDecimals', () => {
  it('renders an unknown scale as no scale — the number is then the base-unit count', () => {
    expect(displayDecimals(null)).toBe(0)
  })

  it('passes a known scale through, including a genuine zero', () => {
    expect(displayDecimals(6)).toBe(6)
    expect(displayDecimals(0)).toBe(0)
  })
})

describe('unknownTokenInfo', () => {
  it('decodes a printable asset name to UTF-8 as the NAME, with the scale unknown', () => {
    const info = unknownTokenInfo(ID_TEST)
    // The decoded asset name is what the minter called it — a name, not a ticker.
    // And nothing stated the scale, so it is null rather than a 0 that would
    // silently render every quantity as whole units.
    expect(info).toMatchObject({decimals: null, name: 'TEST', label: 'TEST', known: false, isNft: false})
  })
  it('labels an undecodable name with its CIP-14 fingerprint, and claims no name', () => {
    // Never the first bytes of the asset name: that is a hex fragment sitting where
    // a name goes, and for a CIP-68 asset it is the label prefix, so every
    // unrelated token read the same. And never the policy alone — see below.
    const info = unknownTokenInfo(ID_BINARY)
    expect(info.label).toMatch(/^asset1.+\u2026.+$/)
    expect(info.name).toBeUndefined()
  })
  it('gives two nameless assets under ONE policy different labels', () => {
    // The policy-truncation fallback labelled both of these `f5808c2c…`. Real case:
    // a Minswap pool whose hash-named pool token shares its policy with `MSP`.
    const a = unknownTokenInfo(`${POLICY}.${'11'.repeat(32)}`)
    const b = unknownTokenInfo(`${POLICY}.${'22'.repeat(32)}`)
    expect(a.label).not.toBe(b.label)
  })
  it('reads a CIP-68 name through its label prefix', () => {
    // 0014df10 (label 333) + "CLIP IT" — this rendered as "0014df10" before.
    const info = unknownTokenInfo(`${POLICY}.0014df10434c4950204954`)
    expect(info).toMatchObject({name: 'CLIP IT', label: 'CLIP IT'})
  })
  it('maps ADA sentinels to the ADA info', () => {
    expect(unknownTokenInfo('')).toMatchObject({ticker: 'ADA', decimals: 6})
    expect(unknownTokenInfo('.')).toMatchObject({ticker: 'ADA', decimals: 6})
  })
})

describe('fetchTokenInfos', () => {
  const run = <A>(e: Effect.Effect<A>) => Effect.runPromise(e)

  it('resolves ADA locally and secondary ids from SteelSwap metadata', async () => {
    const fetchImpl = stubFetch({
      '/api/v2/tokens/metadata': {
        tokens: [{unit: UNIT_TEST, decimals: 6, decimalsKnown: true, ticker: 'TST', name: 'Test Token'}],
      },
    })
    const infos = await run(fetchTokenInfos(['', ID_TEST], MAINNET, fetchImpl, 1_000))
    expect(infos.get('')).toMatchObject({ticker: 'ADA', decimals: 6})
    expect(infos.get(ID_TEST)).toMatchObject({decimals: 6, ticker: 'TST', label: 'TST', known: true, isNft: false})
  })

  it('keeps a resolved token whose decimals SteelSwap does not know, without inventing 0', async () => {
    const fetchImpl = stubFetch({
      '/api/v2/tokens/metadata': {
        tokens: [{unit: UNIT_TEST, decimals: 0, decimalsKnown: false, ticker: 'UNV', name: 'Unverified'}],
      },
    })
    const infos = await run(fetchTokenInfos([ID_TEST], MAINNET, fetchImpl, 1_000))
    expect(infos.get(ID_TEST)).toMatchObject({decimals: null, ticker: 'UNV', known: true})
  })

  it('degrades unresolved + failed ids to unknown-info (never throws)', async () => {
    const failing = stubFetch({}, false, 500)
    const infos = await run(fetchTokenInfos([ID_TEST], MAINNET, failing, 1_000))
    expect(infos.get(ID_TEST)).toMatchObject({known: false, decimals: null, name: 'TEST'})
  })

  it('degrades a malformed id (no policy/name split) to unknown without a request', async () => {
    const infos = await run(fetchTokenInfos(['nodot'], MAINNET, stubFetch({}), 1_000))
    expect(infos.get('nodot')).toMatchObject({known: false})
  })
})

describe('price', () => {
  const run = <A>(e: Effect.Effect<A>) => Effect.runPromise(e)
  // Kraken Ticker body for an ADA close price (`result[pair].c[0]`).
  const krakenTicker = (price: number) => ({error: [], result: {ADAUSD: {c: [String(price), '0']}}})

  it('reads ADA→fiat for USD from the Kraken ticker', async () => {
    const fetchImpl = stubFetch({'/0/public/Ticker': krakenTicker(0.42)})
    expect(await run(fetchAdaPrice('USD', 1_000, MAINNET, fetchImpl))).toBe(0.42)
  })

  it('returns null for a currency Kraken has no ADA pair for (JPY)', async () => {
    // JPY isn't a Kraken ADA fiat → null before any fetch, never a wrong number.
    const fetchImpl = stubFetch({'/0/public/Ticker': krakenTicker(63.5)})
    expect(await run(fetchAdaPrice('JPY', 1_000, MAINNET, fetchImpl))).toBeNull()
  })

  it('returns null when the Kraken ticker fails (no fallback)', async () => {
    // No ticker route → Kraken 404s → null, never a wrong number.
    expect(await run(fetchAdaPrice('USD', 1_000, MAINNET, stubFetch({})))).toBeNull()
  })

  it('prices tokens as spot(ADA) × ADA→fiat, ADA ids at the ADA rate', async () => {
    const fetchImpl = stubFetch({
      '/0/public/Ticker': krakenTicker(0.5),
      '/api/v2/taptools/token/prices': {[UNIT_TEST]: 4},
    })
    const prices = await run(fetchTokenPrices(['', ID_TEST], 'USD', 1_000, MAINNET, fetchImpl))
    expect(prices.get('')).toBe(0.5) // ADA
    expect(prices.get(ID_TEST)).toBe(2) // 4 ADA × $0.5
  })

  it('omits unpriced tokens (no 0 fallback)', async () => {
    const fetchImpl = stubFetch({
      '/0/public/Ticker': krakenTicker(0.5),
      '/api/v2/taptools/token/prices': {}, // no spot for the id
    })
    const prices = await run(fetchTokenPrices([ID_TEST], 'USD', 1_000, MAINNET, fetchImpl))
    expect(prices.has(ID_TEST)).toBe(false)
  })

  it('returns an empty map when ADA is unpriced', async () => {
    const prices = await run(fetchTokenPrices(['', ID_TEST], 'USD', 1_000, MAINNET, stubFetch({}, false, 500)))
    expect(prices.size).toBe(0)
  })
})
