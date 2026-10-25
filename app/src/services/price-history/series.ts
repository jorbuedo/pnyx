/**
 * Load a major asset's close-price series (priced directly in a fiat) for a
 * chart window, backed by the persisted price-point store. Read-through: serve
 * cached points, and pull from the {@link PriceHistorySource} only when the tip
 * is stale or the window isn't covered (and hasn't already been attempted this
 * session — Kraken's ~2-year horizon means a still-uncovered deep window won't
 * fill on retry). Fetched points are bucketed, persisted (immutable), merged.
 *
 * Each fiat is a separate series (`major:ADA:EUR`, …) sourced from its own
 * Kraken pair, so historical values are accurate per fiat — no FX approximation.
 *
 * @module
 */

import type {PricePointRow} from '@pnyx/store/price-point-table'
import {hasDeepAdaHistory, loadDeepAdaPoints} from './deep-ada-history'
import type {FiatSymbol, MajorAsset, PriceHistorySource, PricePoint} from './port'
import {pruneSeries, readSeriesRange, writeSeriesPoints} from './price-point-store'
import {
  type ChartRange,
  isTipStale,
  isUncovered,
  majorSeriesKey,
  stepSecFor,
  type TimeWindow,
  toBucket,
  tokenAdaSeriesKey,
} from './range'

/** Merge cached + freshly-fetched points by bucket (fetched wins), ascending. */
const mergeByBucket = (cached: readonly PricePoint[], fresh: readonly PricePoint[]): PricePoint[] => {
  const byBucket = new Map<number, number>()
  for (const p of cached) byBucket.set(toBucket(p.ts), p.value)
  for (const p of fresh) byBucket.set(toBucket(p.ts), p.value)
  return [...byBucket.entries()].map(([ts, value]) => ({ts, value})).sort((a, b) => a.ts - b.ts)
}

// Collapse concurrent identical loads into one request. Many consumers hit the
// same series at once — the aggregate chart, every per-row sparkline, the
// activity resolver — and without this each fires its own fetch, hammering the
// rate limit (SteelSwap 429s). Keyed by series + range + window bucket.
const inflight = new Map<string, Promise<readonly PricePoint[]>>()
const dedup = (key: string, run: () => Promise<readonly PricePoint[]>): Promise<readonly PricePoint[]> => {
  const existing = inflight.get(key)
  if (existing !== undefined) return existing
  const p = run().finally(() => inflight.delete(key))
  inflight.set(key, p)
  return p
}
const windowKey = (window: TimeWindow): string => `${toBucket(window.fromSec)}-${toBucket(window.toSec)}`

/**
 * Cached-then-network USD price points for `asset` over `window`. `attempted`
 * is the caller's per-session set of `seriesKey|range` windows already pulled,
 * so a deep window Kraken can't satisfy is fetched once, not on every render.
 * Returns the merged series (empty only if there's neither cache nor fetch).
 */
const loadMajorFiatSeriesImpl = async (
  source: PriceHistorySource,
  network: string,
  asset: MajorAsset,
  fiat: FiatSymbol,
  window: TimeWindow,
  range: ChartRange,
  attempted: Set<string>,
): Promise<readonly PricePoint[]> => {
  const seriesKey = majorSeriesKey(asset, fiat)
  const step = stepSecFor(range, window)
  // Read one step below `fromSec`: the point holding the price AT `fromSec` is the
  // one before it, and excluding it here would re-fetch it on every render.
  const cachedRows = await readSeriesRange(network, seriesKey, toBucket(window.fromSec - step), toBucket(window.toSec))
  const cached: PricePoint[] = cachedRows.map((r) => ({ts: r.tsBucket, value: r.value}))

  // Kraken (recent + tip, ~2yr horizon).
  let merged = cached
  const attemptKey = `${seriesKey}|${range}`
  const wantTip = isTipStale(cached, window.toSec, step)
  const wantCoverage = isUncovered(cached, window, step) && !attempted.has(attemptKey)
  if (wantTip || wantCoverage) {
    attempted.add(attemptKey)
    const fetched = await source.majorFiatSeries(asset, fiat, window.fromSec, window.toSec)
    if (fetched.length > 0) {
      const rows: PricePointRow[] = fetched.map((p) => ({
        network,
        seriesKey,
        tsBucket: toBucket(p.ts),
        value: p.value,
        source: 'kraken',
      }))
      await writeSeriesPoints(rows)
      merged = mergeByBucket(
        cached,
        rows.map((r) => ({ts: r.tsBucket, value: r.value})),
      )
    }
  }

  // Deep-history top-up: when the window reaches older than Kraken can cover,
  // fill the old end from the static deep ADA→fiat dataset (once per session).
  if (asset === 'ADA' && hasDeepAdaHistory()) {
    const deepKey = `deep:${seriesKey}|${range}`
    const oldest = merged[0]
    const uncoveredOldEnd = oldest === undefined || oldest.ts > window.fromSec + step
    if (uncoveredOldEnd && !attempted.has(deepKey)) {
      attempted.add(deepKey)
      const deep = await loadDeepAdaPoints(fiat, window.fromSec, oldest?.ts ?? window.toSec)
      if (deep.length > 0) {
        const deepRows: PricePointRow[] = deep.map((p) => ({
          network,
          seriesKey,
          tsBucket: toBucket(p.ts),
          value: p.value,
          source: 'deep',
        }))
        await writeSeriesPoints(deepRows)
        merged = mergeByBucket(
          merged,
          deepRows.map((r) => ({ts: r.tsBucket, value: r.value})),
        )
      }
    }
  }
  // Bound growth: downsample the series once per session (fire-and-forget).
  void pruneSeries(network, seriesKey, window.toSec)
  return merged
}

/** {@link loadMajorFiatSeriesImpl}, with concurrent identical loads deduped. */
export const loadMajorFiatSeries = (
  source: PriceHistorySource,
  network: string,
  asset: MajorAsset,
  fiat: FiatSymbol,
  window: TimeWindow,
  range: ChartRange,
  attempted: Set<string>,
): Promise<readonly PricePoint[]> =>
  dedup(`m|${network}|${majorSeriesKey(asset, fiat)}|${range}|${windowKey(window)}`, () =>
    loadMajorFiatSeriesImpl(source, network, asset, fiat, window, range, attempted),
  )

/** Fetches a token's ADA-denominated OHLCV close series for a range (SteelSwap). */
export type TokenAdaFetcher = (unit: string, range: ChartRange) => Promise<readonly PricePoint[]>

/**
 * Cached-then-network ADA-denominated price points for a token `unit` over
 * `window`, backed by the price-point store under `tokenada:<unit>`. Mirrors
 * {@link loadMajorUsdSeries} but sources from SteelSwap OHLCV (token→ADA); the
 * caller composes fiat as `tokenAda × adaFiat`. `attempted` guards a window the
 * source can't cover from re-fetching each render. Empty when neither cache nor
 * fetch yields data (never a fabricated point).
 */
const loadTokenAdaSeriesImpl = async (
  fetchOhlcv: TokenAdaFetcher,
  network: string,
  unit: string,
  window: TimeWindow,
  range: ChartRange,
  attempted: Set<string>,
): Promise<readonly PricePoint[]> => {
  if (unit.length === 0) return []
  const seriesKey = tokenAdaSeriesKey(unit)
  const step = stepSecFor(range, window)
  const cachedRows = await readSeriesRange(network, seriesKey, toBucket(window.fromSec - step), toBucket(window.toSec))
  const cached: PricePoint[] = cachedRows.map((r) => ({ts: r.tsBucket, value: r.value}))
  const attemptKey = `${seriesKey}|${range}`
  const wantTip = isTipStale(cached, window.toSec, step)
  const wantCoverage = isUncovered(cached, window, step) && !attempted.has(attemptKey)
  if (!wantTip && !wantCoverage) return cached

  attempted.add(attemptKey)
  // One step of slack on the low end, for the same reason as the Kraken adapter:
  // the price *at* `fromSec` lives in the candle that opened before it.
  const lowerBound = window.fromSec - step
  const fetched = (await fetchOhlcv(unit, range)).filter((p) => p.ts >= lowerBound && p.ts <= window.toSec)
  if (fetched.length === 0) return cached

  const rows: PricePointRow[] = fetched.map((p) => ({
    network,
    seriesKey,
    tsBucket: toBucket(p.ts),
    value: p.value,
    source: 'steelswap',
  }))
  await writeSeriesPoints(rows)
  void pruneSeries(network, seriesKey, window.toSec)
  return mergeByBucket(
    cached,
    rows.map((r) => ({ts: r.tsBucket, value: r.value})),
  )
}

/** {@link loadTokenAdaSeriesImpl}, with concurrent identical loads deduped. */
export const loadTokenAdaSeries = (
  fetchOhlcv: TokenAdaFetcher,
  network: string,
  unit: string,
  window: TimeWindow,
  range: ChartRange,
  attempted: Set<string>,
): Promise<readonly PricePoint[]> =>
  dedup(`t|${network}|${tokenAdaSeriesKey(unit)}|${range}|${windowKey(window)}`, () =>
    loadTokenAdaSeriesImpl(fetchOhlcv, network, unit, window, range, attempted),
  )
