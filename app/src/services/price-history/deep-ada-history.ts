/**
 * Deep ADA→fiat history — the static, daily dataset that extends ADA price
 * history past Kraken's live ~2-year OHLC-API window (old txs, full "ALL"
 * charts, tax CSV). Sourced from Kraken's downloadable OHLCVT archive, reduced
 * to daily closes and hosted as one small R2 object (refreshed per quarter);
 * see `app/scripts/build-deep-ada-history.ts` for the reducer.
 *
 * Served R2-direct from the `pnyx-data` bucket's public domain (`data.pxkq.uk`,
 * the same free-read path as the DRep/pool blobs), refreshed by the
 * `services/data-worker` cron. The URL can be overridden with
 * `EXPO_PUBLIC_DEEP_ADA_HISTORY_URL`. Until the blob is uploaded the fetch 404s
 * and the adapter is a graceful no-op (deep queries degrade to unpriced).
 *
 * @module
 */

import {deepAdaHistoryRaw} from '../../config/env'
import {logger} from '../../logger'
import type {FetchLike, PricePoint} from './port'

/** R2-direct default (matches the DRep/pool `DATA_URL` convention). */
const DEFAULT_DEEP_URL = 'https://data.pxkq.uk/deep-ada-history.json'

/** `{ fiats: { USD: [[unixSec, close], …] }, … }` — daily closes per fiat, ascending. */
export type DeepAdaDataset = {readonly fiats: Record<string, ReadonlyArray<readonly [number, number]>>}

// Read at call time (still inlined by Expo for `process.env.EXPO_PUBLIC_*`), so
// the URL is overridable per env and the adapter is testable. An explicit empty
// override (`EXPO_PUBLIC_DEEP_ADA_HISTORY_URL=""` → literal `"off"`) disables it.
const deepUrl = (): string | undefined => {
  const override = deepAdaHistoryRaw()
  if (override === 'off') return undefined
  const t = override?.trim()
  return t !== undefined && t.length > 0 ? t : DEFAULT_DEEP_URL
}

/** Whether a deep-history dataset URL is configured (default: on). */
export const hasDeepAdaHistory = (): boolean => deepUrl() !== undefined

/** Points for `fiat` within `[fromSec, toSec]` (inclusive), ascending. Pure. */
export const deepPointsInRange = (
  dataset: DeepAdaDataset,
  fiat: string,
  fromSec: number,
  toSec: number,
): PricePoint[] => {
  const rows = dataset.fiats[fiat]
  if (rows === undefined) return []
  const out: PricePoint[] = []
  for (const row of rows) {
    const ts = row[0]
    const value = row[1]
    if (Number.isFinite(ts) && Number.isFinite(value) && ts >= fromSec && ts <= toSec) out.push({ts, value})
  }
  return out.sort((a, b) => a.ts - b.ts)
}

const defaultFetch: FetchLike = (url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<FetchLike>

// The dataset is static (per quarter) — fetch it once per process, then serve
// every query from memory. `loaded` guards against re-fetching on a 404/parse
// failure (a missing dataset stays missing for the session, not each call).
let cached: DeepAdaDataset | null = null
let loaded = false

/** Reset the in-memory dataset (tests). */
export const clearDeepAdaHistory = (): void => {
  cached = null
  loaded = false
}

const isDataset = (v: unknown): v is DeepAdaDataset =>
  v !== null && typeof v === 'object' && typeof (v as {fiats?: unknown}).fiats === 'object'

/**
 * Deep ADA→`fiat` daily points within `[fromSec, toSec]`, or empty when no
 * dataset is configured / reachable / lacks that fiat. Best-effort: fetched
 * once, cached, never throws (the series layer degrades to unpriced).
 */
export const loadDeepAdaPoints = async (
  fiat: string,
  fromSec: number,
  toSec: number,
  fetchImpl: FetchLike = defaultFetch,
): Promise<readonly PricePoint[]> => {
  const url = deepUrl()
  if (url === undefined) return []
  if (!loaded) {
    loaded = true
    try {
      const r = await fetchImpl(url, {headers: {Accept: 'application/json'}})
      if (r.ok) {
        const body = await r.json()
        if (isDataset(body)) cached = body
      }
    } catch (e: unknown) {
      // `null` means "no deep history", which the chart renders as a shorter range rather than
      // as a fetch that failed.
      logger.warn('Deep ADA price history could not be fetched', {
        origin: 'price-history/deep-ada',
        error: String(e),
      })
      cached = null
    }
  }
  return cached === null ? [] : deepPointsInRange(cached, fiat, fromSec, toSec)
}
