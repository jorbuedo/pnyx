import {MemoryPricePointTable} from '@pnyx/store/price-point-table.memory'
import {Effect} from 'effect'
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it} from 'vitest'
import {clearDeepAdaHistory} from './deep-ada-history'
import type {MajorAsset, PriceHistorySource, PricePoint} from './port'
import {clearPricePointStore, setPricePointStore} from './price-point-store'
import {majorSeriesKey, type TimeWindow, toBucket} from './range'
import {loadMajorFiatSeries, loadTokenAdaSeries, type TokenAdaFetcher} from './series'

// These tests exercise cache/fetch/bucketing over the injected stub source only.
// Disable the deep ADA→fiat top-up so no test reaches the live R2 dataset
// (its real daily points would otherwise be merged in as older `out[0]` points).
const prevDeepUrl = process.env.EXPO_PUBLIC_DEEP_ADA_HISTORY_URL
beforeAll(() => {
  process.env.EXPO_PUBLIC_DEEP_ADA_HISTORY_URL = 'off'
  clearDeepAdaHistory()
})
afterAll(() => {
  if (prevDeepUrl === undefined) delete process.env.EXPO_PUBLIC_DEEP_ADA_HISTORY_URL
  else process.env.EXPO_PUBLIC_DEEP_ADA_HISTORY_URL = prevDeepUrl
  clearDeepAdaHistory()
})

const NOW = 1_700_000_000
const DAY = 86400
const NET = 'mainnet'

/** A source that records its call count and returns the supplied points. */
const stubSource = (points: readonly PricePoint[]): {source: PriceHistorySource; state: {calls: number}} => {
  const state = {calls: 0}
  const source: PriceHistorySource = {
    majorFiatSeries: (_a: MajorAsset, _f, _from, _to) => {
      state.calls++
      return Promise.resolve(points)
    },
    majorFiatSpot: () => Promise.resolve(null),
  }
  return {source, state}
}

const window1D: TimeWindow = {fromSec: NOW - DAY, toSec: NOW}

describe('loadMajorFiatSeries', () => {
  beforeEach(async () => {
    setPricePointStore(await Effect.runPromise(MemoryPricePointTable))
  })
  afterEach(() => clearPricePointStore())

  it('fetches, persists, and returns points on a cold cache', async () => {
    const pts: PricePoint[] = [
      {ts: NOW - DAY, value: 0.4},
      {ts: NOW - DAY / 2, value: 0.45},
      {ts: NOW - 60, value: 0.5},
    ]
    const {source} = stubSource(pts)
    const attempted = new Set<string>()
    const out = await loadMajorFiatSeries(source, NET, 'ADA', 'USD', window1D, '1D', attempted)
    expect(out.map((p) => p.value)).toEqual([0.4, 0.45, 0.5])
    expect(attempted.has(`${majorSeriesKey('ADA', 'USD')}|1D`)).toBe(true)
  })

  it('serves a warm, fresh cache without hitting the network', async () => {
    const fresh: PricePoint[] = [
      {ts: NOW - DAY, value: 0.4},
      {ts: NOW - 60, value: 0.5},
    ]
    const first = stubSource(fresh)
    await loadMajorFiatSeries(first.source, NET, 'ADA', 'USD', window1D, '1D', new Set())
    // A second load with a source that would return nothing still yields cached data.
    const second = stubSource([])
    const out = await loadMajorFiatSeries(second.source, NET, 'ADA', 'USD', window1D, '1D', new Set())
    expect(out.length).toBe(2)
    expect(second.state.calls).toBe(0)
  })

  it('refetches when the cached tip is stale', async () => {
    // Seed a cache whose newest point is a full day old (stale for a 1D window).
    const stale = stubSource([{ts: NOW - DAY, value: 0.3}])
    await loadMajorFiatSeries(
      stale.source,
      NET,
      'ADA',
      'USD',
      {fromSec: NOW - 2 * DAY, toSec: NOW - DAY},
      '1D',
      new Set(),
    )
    // Now request the live 1D window: tip is stale → must fetch.
    const live = stubSource([{ts: NOW - 60, value: 0.55}])
    const out = await loadMajorFiatSeries(live.source, NET, 'ADA', 'USD', window1D, '1D', new Set())
    expect(live.state.calls).toBe(1)
    expect(out.some((p) => p.value === 0.55)).toBe(true)
  })

  it('does not refetch an already-attempted window once the tip is fresh', async () => {
    // Warm the ADA/ALL window with a fresh (recent) tip and mark it attempted.
    const attempted = new Set<string>()
    const warm = stubSource([{ts: NOW - 60, value: 1}])
    await loadMajorFiatSeries(warm.source, NET, 'ADA', 'USD', window1D, 'ALL', attempted)
    expect(warm.state.calls).toBe(1)
    // Cache is shallow (one point) so the window is still "uncovered", but the
    // tip is fresh AND the window was attempted → no second fetch.
    const again = stubSource([{ts: NOW - 20, value: 2}])
    const out = await loadMajorFiatSeries(again.source, NET, 'ADA', 'USD', window1D, 'ALL', attempted)
    expect(again.state.calls).toBe(0)
    expect(out.length).toBeGreaterThan(0)
  })

  it('buckets fetched timestamps to 5-minute alignment', async () => {
    const {source} = stubSource([{ts: NOW - 123, value: 0.9}])
    const out = await loadMajorFiatSeries(source, NET, 'ADA', 'USD', window1D, '1D', new Set())
    expect(out[0]?.ts).toBe(toBucket(NOW - 123))
  })
})

const UNIT = `${'a'.repeat(56)}01`

describe('loadTokenAdaSeries', () => {
  beforeEach(async () => {
    setPricePointStore(await Effect.runPromise(MemoryPricePointTable))
  })
  afterEach(() => clearPricePointStore())

  it('fetches, persists, and returns token→ADA points on a cold cache', async () => {
    let calls = 0
    const fetchOhlcv: TokenAdaFetcher = () => {
      calls++
      return Promise.resolve([
        {ts: NOW - DAY, value: 0.001},
        {ts: NOW - 60, value: 0.0012},
      ])
    }
    const out = await loadTokenAdaSeries(fetchOhlcv, NET, UNIT, window1D, '1D', new Set())
    expect(out.map((p) => p.value)).toEqual([0.001, 0.0012])
    expect(calls).toBe(1)
  })

  it('serves a warm, fresh cache without hitting the network', async () => {
    const fresh = [
      {ts: NOW - DAY, value: 0.001},
      {ts: NOW - 60, value: 0.0012},
    ]
    await loadTokenAdaSeries(() => Promise.resolve(fresh), NET, UNIT, window1D, '1D', new Set())
    let calls = 0
    const out = await loadTokenAdaSeries(
      () => {
        calls++
        return Promise.resolve([])
      },
      NET,
      UNIT,
      window1D,
      '1D',
      new Set(),
    )
    expect(out.length).toBe(2)
    expect(calls).toBe(0)
  })

  it('drops points outside the window and returns empty for ADA (empty unit)', async () => {
    const out = await loadTokenAdaSeries(
      () => Promise.resolve([{ts: NOW - 5 * DAY, value: 9}]),
      NET,
      UNIT,
      window1D,
      '1D',
      new Set(),
    )
    expect(out.length).toBe(0) // the only point predates the 1D window
    expect(
      await loadTokenAdaSeries(() => Promise.resolve([{ts: NOW, value: 1}]), NET, '', window1D, '1D', new Set()),
    ).toEqual([])
  })
})
