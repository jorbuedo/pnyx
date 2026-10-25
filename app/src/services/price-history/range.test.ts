import {describe, expect, it} from 'vitest'
import type {PricePoint} from './port'
import {
  BUCKET_SEC,
  CHART_RANGES,
  type ChartRange,
  isTipStale,
  isUncovered,
  majorSeriesKey,
  RANGE_SPECS,
  rangeWindow,
  steelswapOhlcvParams,
  stepSecFor,
  toBucket,
  tokenAdaSeriesKey,
} from './range'

const NOW = 1_700_000_000
const DAY = 86400

describe('toBucket', () => {
  it('floors to the 5-minute bucket', () => {
    expect(toBucket(NOW + 123)).toBe(Math.floor((NOW + 123) / BUCKET_SEC) * BUCKET_SEC)
    expect(toBucket(0)).toBe(0)
  })
  it('is idempotent on an already-aligned timestamp', () => {
    const b = toBucket(NOW)
    expect(toBucket(b)).toBe(b)
  })
  it('leaves a daily (midnight-UTC) timestamp untouched — it is bucket-aligned', () => {
    const midnight = Math.floor(NOW / DAY) * DAY
    expect(toBucket(midnight)).toBe(midnight)
  })
})

describe('rangeWindow', () => {
  it('fixed ranges look back the full span from now', () => {
    for (const range of ['1D', '1W', '1M', '6M', '1Y'] as ChartRange[]) {
      const spec = RANGE_SPECS[range]
      const w = rangeWindow(range, NOW, null)
      expect(w.toSec).toBe(NOW)
      expect(w.fromSec).toBe(NOW - (spec.spanSec as number))
    }
  })
  it('fixed range ignores wallet age (value is 0 before first funds)', () => {
    const w = rangeWindow('1Y', NOW, NOW - 3 * DAY)
    expect(w.fromSec).toBe(NOW - 365 * DAY)
  })
  it('ALL spans from wallet start to now', () => {
    const start = NOW - 42 * DAY
    expect(rangeWindow('ALL', NOW, start)).toEqual({fromSec: start, toSec: NOW})
  })
  it('ALL degenerates to a 1-day window when the wallet has no start', () => {
    expect(rangeWindow('ALL', NOW, null)).toEqual({fromSec: NOW - DAY, toSec: NOW})
  })
  it('ALL ignores a start at/after now', () => {
    expect(rangeWindow('ALL', NOW, NOW + 100).fromSec).toBe(NOW - DAY)
  })
})

describe('stepSecFor', () => {
  it('divides the span by (pointCount - 1)', () => {
    const w = {fromSec: NOW - DAY, toSec: NOW}
    // 1D → 96 points → 95 gaps
    expect(stepSecFor('1D', w)).toBeCloseTo(DAY / 95)
  })
})

const pts = (...ts: number[]): PricePoint[] => ts.map((t) => ({ts: t, value: 1}))

describe('isTipStale', () => {
  const step = 900
  it('is true for an empty series', () => {
    expect(isTipStale([], NOW, step)).toBe(true)
  })
  it('tolerates a tip within a few steps (no refresh for a slightly-old tip)', () => {
    expect(isTipStale(pts(NOW - 2 * step), NOW, step)).toBe(false) // 2 steps < TIP_STALE_STEPS (3)
    expect(isTipStale(pts(NOW - 300, NOW - 60), NOW, step)).toBe(false)
  })
  it('is true when the newest point is more than a few steps behind', () => {
    expect(isTipStale(pts(NOW - 5 * step), NOW, step)).toBe(true)
  })
})

describe('isUncovered', () => {
  const window = {fromSec: NOW - DAY, toSec: NOW}
  const step = DAY / 95
  it('is true for an empty series', () => {
    expect(isUncovered([], window, step)).toBe(true)
  })
  it('is true when the oldest point starts well after the window start', () => {
    expect(isUncovered(pts(NOW - DAY / 2, NOW), window, step)).toBe(true)
  })
  it('is false when the oldest point reaches back to the window start', () => {
    expect(isUncovered(pts(window.fromSec, NOW), window, step)).toBe(false)
  })
})

describe('majorSeriesKey', () => {
  it('names a per-fiat series for ADA', () => {
    expect(majorSeriesKey('ADA', 'USD')).toBe('major:ADA:USD')
  })
})

describe('tokenAdaSeriesKey', () => {
  it('names a per-token ADA series', () => {
    expect(tokenAdaSeriesKey('abc123')).toBe('tokenada:abc123')
  })
})

describe('steelswapOhlcvParams', () => {
  it('picks an interval + count that spans each range', () => {
    expect(steelswapOhlcvParams('1D')).toEqual({interval: '15m', numIntervals: 96})
    expect(steelswapOhlcvParams('1W')).toEqual({interval: '1h', numIntervals: 168})
    expect(steelswapOhlcvParams('1Y')).toEqual({interval: '1d', numIntervals: 365})
    expect(steelswapOhlcvParams('ALL').interval).toBe('1w')
  })
  it('every interval boundary is a multiple of the 5-min bucket', () => {
    const secs: Record<string, number> = {'15m': 900, '1h': 3600, '4h': 14400, '1d': 86400, '1w': 604800}
    for (const r of CHART_RANGES) {
      const s = secs[steelswapOhlcvParams(r).interval]
      expect(s !== undefined && s % BUCKET_SEC === 0).toBe(true)
    }
  })
})
