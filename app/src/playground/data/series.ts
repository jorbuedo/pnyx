/**
 * Chart series fixtures for the UI Playground.
 *
 * Deterministic pseudo-random walk — no Math.random, so successive reloads show
 * the same curve and a visual diff means a real change.
 *
 * @module
 */

import type {SeriesPoint} from '../../components/chart/chart-geometry'

const DAY_SEC = 86_400

/** Cheap deterministic hash → [0, 1). */
const noise = (i: number): number => {
  const x = Math.sin(i * 12.9898) * 43_758.5453
  return x - Math.floor(x)
}

/**
 * A rising series with visible volatility.
 *
 * @param count - number of points
 * @param start - starting value
 * @param endTs - unix seconds of the newest point
 */
export const makeSeries = (count: number, start: number, endTs = 1_767_225_600): readonly SeriesPoint[] => {
  const points: SeriesPoint[] = []
  let value = start
  for (let i = 0; i < count; i++) {
    value = Math.max(0.01, value * (1 + (noise(i) - 0.45) * 0.06))
    points.push({ts: endTs - (count - 1 - i) * DAY_SEC, value: Number(value.toFixed(4))})
  }
  return points
}

/** ~1 month of portfolio value in fiat. */
export const fakeValueSeries = makeSeries(30, 3_800)

/** ~1 month of a token price. */
export const fakePriceSeries = makeSeries(30, 0.42)

/** Short series for the sparkline. */
export const fakeSparkSeries = makeSeries(12, 1.0)

/** A resolved chart state, as the portfolio/price hooks would return. `snapshotAt` is null here for
 * the same reason a single-asset chart returns null: there is no portfolio behind a fixture. */
export const fakeChartState = {
  series: fakeValueSeries,
  loading: false,
  currency: 'USD',
  snapshotAt: null,
} as const

/** The pre-resolution state, for the loading branch. */
export const fakeChartStateLoading = {
  series: [],
  loading: true,
  currency: 'USD',
  snapshotAt: null,
} as const
