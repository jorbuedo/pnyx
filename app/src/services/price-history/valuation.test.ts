import type {ReviewedAmount, ReviewedTransaction} from '@pnyx/tx-review'
import {describe, expect, it} from 'vitest'
import {ADA_KEY, buildBalanceTimeline} from './balance-timeline'
import type {PricePoint} from './port'
import {buildValueSeries, evenTimestamps, type PriceUsdResolver, pointsResolver, txFiatDelta} from './valuation'

const NIGHT = 'nightpolicy.4e49474854'
const iso = (sec: number) => new Date(sec * 1000).toISOString()
const tx = (sec: number, ownDelta: ReviewedAmount[]): ReviewedTransaction =>
  ({chain: 'cardano', timestamp: iso(sec), status: 'confirmed', ownDelta}) as unknown as ReviewedTransaction

// ADA & NIGHT holdings over time.
const timeline = buildBalanceTimeline([
  tx(1000, [{quantity: 10_000000n}]),
  tx(2000, [{quantity: 5_000000n}, {assetId: NIGHT, quantity: 100_000000n}]),
  tx(3000, [{quantity: -3_000000n}]),
])

// USD price series (whole-unit prices).
const adaUsd: PricePoint[] = [
  {ts: 1000, value: 0.5},
  {ts: 2000, value: 0.6},
  {ts: 3000, value: 0.4},
]
const nightUsd: PricePoint[] = [
  {ts: 2000, value: 0.02},
  {ts: 3000, value: 0.03},
]

const adaResolve = pointsResolver(adaUsd)
const nightResolve = pointsResolver(nightUsd)
const resolver: PriceUsdResolver = (key, ts) =>
  key === ADA_KEY ? adaResolve(ts) : key === NIGHT ? nightResolve(ts) : null
const decimalsOf = () => 6

describe('valuation — ADA/NIGHT value series (Phase 0 exit)', () => {
  it('computes aggregate portfolio value at sample timestamps', () => {
    const series = buildValueSeries(timeline, [500, 2500, 3000], resolver, decimalsOf)
    // t=500: nothing held yet
    expect(series[0]).toEqual({ts: 500, value: 0})
    // t=2500: 15 ADA × 0.6 + 100 NIGHT × 0.02 = 9 + 2 = 11
    expect(series[1]?.value).toBeCloseTo(11, 9)
    // t=3000: 12 ADA × 0.4 + 100 NIGHT × 0.03 = 4.8 + 3 = 7.8
    expect(series[2]?.value).toBeCloseTo(7.8, 9)
  })

  it('can value a single token (assetKeys filter)', () => {
    const night = buildValueSeries(timeline, [2500], resolver, decimalsOf, [NIGHT])
    expect(night[0]?.value).toBeCloseTo(2, 9) // 100 × 0.02
  })

  it('skips unpriced assets rather than valuing them at 0', () => {
    const noNight: PriceUsdResolver = (key, ts) => (key === ADA_KEY ? adaResolve(ts) : null)
    const series = buildValueSeries(timeline, [2500], noNight, decimalsOf)
    expect(series[0]?.value).toBeCloseTo(9, 9) // only the 15 ADA × 0.6, NIGHT omitted
  })

  it('attaches fiat to a single tx at its own timestamp', () => {
    // the t=2000 tx: +5 ADA × 0.6 + 100 NIGHT × 0.02 = 3 + 2 = 5
    const fiat = txFiatDelta(
      tx(2000, [{quantity: 5_000000n}, {assetId: NIGHT, quantity: 100_000000n}]),
      resolver,
      decimalsOf,
    )
    expect(fiat).toBeCloseTo(5, 9)
  })

  it('evenTimestamps spans the range inclusively', () => {
    expect(evenTimestamps(0, 100, 5)).toEqual([0, 25, 50, 75, 100])
    expect(evenTimestamps(0, 0, 96)).toEqual([0])
  })
})
