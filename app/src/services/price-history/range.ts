/**
 * Chart-range vocabulary + the pure fetch policy for the price-history series.
 * Pure — no React, no network, no store. Two jobs:
 *
 *  1. Map a {@link ChartRange} to its sample resolution and time window
 *     (Yoroi-class resolution table: 96 / 168 / 180 / 180 / 365 / 256 points).
 *  2. Decide, from what's already cached, whether a series needs a network pull
 *     — split into the two independent reasons a pull can be needed (a stale
 *     tip vs. a window the cache doesn't reach), so the hook can suppress
 *     redundant coverage refetches while still refreshing the tip.
 *
 * Timestamps are unix **seconds**. Cached points are stored at 5-minute buckets
 * ({@link BUCKET_SEC}); Kraken's coarsest interval we request for any range is
 * 5-min, so every candle timestamp is bucket-aligned and flooring is lossless.
 *
 * @module
 */

import type {PricePoint} from './port'

/** Selectable chart windows, coarsest sample density last. */
export type ChartRange = '1D' | '1W' | '1M' | '6M' | '1Y' | 'ALL'

export const CHART_RANGES: readonly ChartRange[] = ['1D', '1W', '1M', '6M', '1Y', 'ALL']

/** Storage bucket for a price point (5 minutes). */
export const BUCKET_SEC = 300

/** Floor a unix-seconds timestamp to its 5-minute bucket. */
export const toBucket = (tsSec: number): number => Math.floor(tsSec / BUCKET_SEC) * BUCKET_SEC

const DAY = 86400

/**
 * Per-range spec. `spanSec` is the fixed look-back; `null` for `ALL`, whose
 * window starts at the wallet's first activity. `pointCount` is how many evenly
 * spaced samples the value series carries for that range.
 */
export type RangeSpec = {readonly spanSec: number | null; readonly pointCount: number}

export const RANGE_SPECS: Record<ChartRange, RangeSpec> = {
  '1D': {spanSec: DAY, pointCount: 96},
  '1W': {spanSec: 7 * DAY, pointCount: 168},
  '1M': {spanSec: 30 * DAY, pointCount: 180},
  '6M': {spanSec: 180 * DAY, pointCount: 180},
  '1Y': {spanSec: 365 * DAY, pointCount: 365},
  ALL: {spanSec: null, pointCount: 256},
}

export type TimeWindow = {readonly fromSec: number; readonly toSec: number}

/**
 * The `[fromSec, toSec]` window for a range. `toSec = nowSec`. Fixed ranges look
 * back the full `spanSec` regardless of wallet age — value is simply 0 before
 * the wallet's first funds. `ALL` spans `[walletStartSec, nowSec]`; if the
 * wallet has no start yet it degenerates to a 1-day window so the chart has an
 * axis.
 */
export const rangeWindow = (range: ChartRange, nowSec: number, walletStartSec: number | null): TimeWindow => {
  const spec = RANGE_SPECS[range]
  if (spec.spanSec === null) {
    const from = walletStartSec !== null && walletStartSec < nowSec ? walletStartSec : nowSec - DAY
    return {fromSec: from, toSec: nowSec}
  }
  return {fromSec: nowSec - spec.spanSec, toSec: nowSec}
}

/** Number of evenly-spaced samples the value series carries for a range. */
export const pointCountFor = (range: ChartRange): number => RANGE_SPECS[range].pointCount

/** Nominal spacing between samples for a window at the range's resolution. */
export const stepSecFor = (range: ChartRange, window: TimeWindow): number => {
  const {pointCount} = RANGE_SPECS[range]
  const span = Math.max(0, window.toSec - window.fromSec)
  return pointCount > 1 ? span / (pointCount - 1) : span
}

/**
 * How many sample steps behind the tip may fall before we refresh it. A chart
 * or sparkline doesn't need the last candle — refreshing a 7-day view because
 * the most recent hour is missing is wasted work (and hammers a rate-limited
 * source). A few steps of tolerance keeps a refresh a true no-op on fresh data.
 */
export const TIP_STALE_STEPS = 3

/**
 * The series is missing recent data: it's empty, or its newest point is more
 * than {@link TIP_STALE_STEPS} sample steps behind `nowSec`.
 */
export const isTipStale = (cached: readonly PricePoint[], nowSec: number, stepSec: number): boolean => {
  const newest = cached[cached.length - 1]
  return newest === undefined || newest.ts < nowSec - stepSec * TIP_STALE_STEPS
}

/**
 * The cache doesn't reach the window's start: it's empty, or its oldest point is
 * more than one step after `window.fromSec` (so early samples would be
 * unpriced). The hook gates this against an "already attempted" set, because
 * Kraken can't return data older than its ~2-year horizon — retrying wouldn't
 * fill the gap, only spin.
 */
export const isUncovered = (cached: readonly PricePoint[], window: TimeWindow, stepSec: number): boolean => {
  const oldest = cached[0]
  return oldest === undefined || oldest.ts > window.fromSec + stepSec
}

/** Series key for a major asset priced directly in `fiat` (e.g. `major:ADA:EUR`). */
export const majorSeriesKey = (asset: 'ADA', fiat: string): string => `major:${asset}:${fiat}`

/** Persisted series key for a token's ADA-denominated price history. */
export const tokenAdaSeriesKey = (unit: string): string => `tokenada:${unit}`

/**
 * SteelSwap OHLCV request params for a range: a candle `interval` and how many
 * candles back (`numIntervals`) to cover the window at chart resolution. Every
 * interval boundary is ≥5-min, so candle timestamps stay {@link BUCKET_SEC}-aligned.
 */
export const steelswapOhlcvParams = (range: ChartRange): {readonly interval: string; readonly numIntervals: number} => {
  switch (range) {
    case '1D':
      return {interval: '15m', numIntervals: 96} // 24h
    case '1W':
      return {interval: '1h', numIntervals: 168} // 7d
    case '1M':
      return {interval: '4h', numIntervals: 180} // 30d
    case '6M':
      return {interval: '1d', numIntervals: 180}
    case '1Y':
      return {interval: '1d', numIntervals: 365}
    case 'ALL':
      return {interval: '1w', numIntervals: 260} // ~5y
  }
}
