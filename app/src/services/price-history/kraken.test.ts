import {describe, expect, it} from 'vitest'
import {makeKrakenPriceSource} from './kraken'
import type {FetchLike} from './port'

const ok = (body: unknown): ReturnType<FetchLike> =>
  Promise.resolve({ok: true, status: 200, json: async () => body}) as ReturnType<FetchLike>

// Stub that records the URL and answers OHLC/Ticker with canned rows.
const makeFetch = (rows: Array<[number, string, string, string, string]>) => {
  const calls: string[] = []
  const fetchImpl: FetchLike = (url) => {
    calls.push(url)
    if (url.includes('/OHLC')) {
      // pad each row to Kraken's 8-tuple shape
      const full = rows.map((r) => [r[0], r[1], r[2], r[3], r[4], '0', '0', 0])
      return ok({error: [], result: {ADAUSD: full, last: 0}})
    }
    if (url.includes('/Ticker')) {
      return ok({error: [], result: {ADAUSD: {c: ['0.1750', '1.0']}}})
    }
    return ok({error: ['unknown'], result: {}})
  }
  return {fetchImpl, calls}
}

describe('makeKrakenPriceSource', () => {
  it('parses OHLC close points and filters to [from,to]', async () => {
    const {fetchImpl} = makeFetch([
      [1000, '0.10', '0.11', '0.09', '0.105'],
      [2000, '0.105', '0.12', '0.10', '0.115'],
      [9999, '0.115', '0.13', '0.11', '0.125'], // out of range → dropped
    ])
    const src = makeKrakenPriceSource(fetchImpl)
    const pts = await src.majorFiatSeries('ADA', 'USD', 1000, 3000)
    expect(pts).toEqual([
      {ts: 1000, value: 0.105},
      {ts: 2000, value: 0.115},
    ])
  })

  it('keeps the candle that opened before `from` — the one holding the price AT `from`', async () => {
    // A transaction-detail review asks for a window starting at the transaction
    // itself. Candles are stamped at their open, so the price at that instant is
    // in the preceding candle; dropping it left the review with no price for the
    // very moment it was asking about, while the activity list (whose window
    // starts at the OLDEST transaction) resolved the same transaction fine.
    const txSec = 6 * 3600 + 100 // mid-candle, 1-min interval for this span
    const {fetchImpl} = makeFetch([
      [txSec - 60, '0.10', '0.11', '0.09', '0.105'], // candle containing txSec
      [txSec + 60, '0.105', '0.12', '0.10', '0.115'],
    ])
    const src = makeKrakenPriceSource(fetchImpl)

    const pts = await src.majorFiatSeries('ADA', 'USD', txSec, txSec + 3600)

    expect(pts[0]).toEqual({ts: txSec - 60, value: 0.105})
    // A resolver that never extrapolates below its first point can now answer at txSec.
    expect((pts[0] as {ts: number}).ts).toBeLessThanOrEqual(txSec)
  })

  it('still drops candles older than the requested step of slack', async () => {
    const from = 6 * 3600
    const {fetchImpl} = makeFetch([
      [from - 600, '0.10', '0.11', '0.09', '0.100'], // 10 min before, 1-min interval → dropped
      [from - 60, '0.10', '0.11', '0.09', '0.105'],
    ])
    const src = makeKrakenPriceSource(fetchImpl)

    const pts = await src.majorFiatSeries('ADA', 'USD', from, from + 3600)

    expect(pts).toEqual([{ts: from - 60, value: 0.105}])
  })

  it('picks a finer interval for short spans, daily for long', async () => {
    const {fetchImpl, calls} = makeFetch([[1000, '0', '0', '0', '0.1']])
    const src = makeKrakenPriceSource(fetchImpl)
    await src.majorFiatSeries('ADA', 'USD', 0, 6 * 3600) // 6h → 1-min
    await src.majorFiatSeries('ADA', 'USD', 0, 400 * 86400) // >2y → daily(1440)
    expect(calls[0]).toContain('interval=1&')
    expect(calls[1]).toContain('interval=1440&')
  })

  it('reads spot from the Ticker close', async () => {
    const {fetchImpl} = makeFetch([])
    const src = makeKrakenPriceSource(fetchImpl)
    expect(await src.majorFiatSpot('ADA', 'USD')).toBe(0.175)
  })

  it('returns empty on API error and null spot on error', async () => {
    const bad: FetchLike = () => ok({error: ['EGeneral:Invalid'], result: {}})
    const src = makeKrakenPriceSource(bad)
    expect(await src.majorFiatSeries('ADA', 'USD', 0, 1000)).toEqual([])
    expect(await src.majorFiatSpot('ADA', 'USD')).toBeNull()
  })
})
