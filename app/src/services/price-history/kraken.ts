/**
 * Kraken adapter (public market data, no key) for ADA → fiat. NIGHT and every
 * other Cardano token are priced via SteelSwap (token→ADA) instead, so ADA is
 * the only pair here.
 *
 * - History: `GET /0/public/OHLC?pair&interval&since` → up to ~720 candles of the
 *   chosen interval. We pick the finest interval whose 720-window spans the
 *   request, so daily reaches ~2 yr (deeper history is the bundled dataset's job).
 * - Spot: `GET /0/public/Ticker?pair` → last-trade close.
 *
 * Base URL is env-overridable (`EXPO_PUBLIC_KRAKEN_URL`) so it's a configured
 * endpoint, per the Third-Party-API policy — never a hard-coded call site.
 *
 * @module
 */

import {krakenUrlOverride} from '../../config/env'
import {logger} from '../../logger'
import type {FetchLike, FiatSymbol, MajorAsset, PriceHistorySource, PricePoint} from './port'

const KRAKEN_URL = krakenUrlOverride() ?? 'https://api.kraken.com'

/** Kraken pair codes. ADA/USD/EUR/GBP/AUD verified live 2026-07-21 (no CHF/JPY/CAD). */
const PAIR: Record<MajorAsset, Partial<Record<FiatSymbol, string>>> = {
  ADA: {USD: 'ADAUSD', EUR: 'ADAEUR', GBP: 'ADAGBP', AUD: 'ADAAUD'},
}

/** Kraken OHLC intervals (minutes) → the coarsest-to-finest ladder we use. */
const INTERVAL_LADDER: readonly number[] = [1, 5, 15, 60, 240, 1440]
const KRAKEN_MAX_CANDLES = 720

/** Finest interval (min) whose 720-candle window covers `spanSec`; caps at daily. */
const pickIntervalMin = (spanSec: number): number => {
  for (const min of INTERVAL_LADDER) {
    if (spanSec <= min * 60 * KRAKEN_MAX_CANDLES) return min
  }
  return 1440
}

const defaultFetch: FetchLike = (url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<FetchLike>

/** First non-`last` key in a Kraken OHLC/Ticker `result` object. */
const resultKey = (result: Record<string, unknown>): string | undefined => Object.keys(result).find((k) => k !== 'last')

export const makeKrakenPriceSource = (fetchImpl: FetchLike = defaultFetch): PriceHistorySource => {
  const getJson = async (path: string): Promise<Record<string, unknown> | null> => {
    try {
      const r = await fetchImpl(`${KRAKEN_URL}${path}`, {headers: {Accept: 'application/json'}})
      if (!r.ok) return null
      const body = (await r.json()) as {error?: unknown[]; result?: Record<string, unknown>}
      if (Array.isArray(body.error) && body.error.length > 0) return null
      return body.result ?? null
    } catch (e: unknown) {
      // `null` is also every rejection branch above it — a non-ok status, an error array — so a
      // network failure and a refused request are one answer to the chart.
      logger.warn('Kraken price request failed', {origin: 'price-history/kraken', error: String(e)})
      return null
    }
  }

  const majorFiatSeries: PriceHistorySource['majorFiatSeries'] = async (asset, fiat, fromSec, toSec) => {
    const pair = PAIR[asset]?.[fiat]
    if (pair === undefined || toSec <= fromSec) return []
    const interval = pickIntervalMin(toSec - fromSec)
    // `since` is exclusive-ish; step back one interval so the first bucket lands.
    const since = Math.max(0, Math.floor(fromSec) - interval * 60)
    const result = await getJson(`/0/public/OHLC?pair=${pair}&interval=${interval}&since=${since}`)
    if (result === null) return []
    const key = resultKey(result)
    const rows = key !== undefined ? result[key] : undefined
    if (!Array.isArray(rows)) return []
    const out: PricePoint[] = []
    for (const row of rows) {
      // [time, open, high, low, close, vwap, volume, count]
      if (!Array.isArray(row)) continue
      const ts = Number(row[0])
      const close = Number(row[4])
      // Keep from `since`, not from `fromSec`: a candle is stamped at its OPEN, so
      // the price *at* `fromSec` lives in the candle that opened before it. Cutting
      // at `fromSec` drops exactly that one, and a resolver that refuses to
      // extrapolate below its first point then has no price for the very moment
      // the caller asked about — which is every single-transaction review, whose
      // window starts at that transaction.
      if (Number.isFinite(ts) && Number.isFinite(close) && ts >= since && ts <= toSec) {
        out.push({ts, value: close})
      }
    }
    return out
  }

  const majorFiatSpot: PriceHistorySource['majorFiatSpot'] = async (asset, fiat) => {
    const pair = PAIR[asset]?.[fiat]
    if (pair === undefined) return null
    const result = await getJson(`/0/public/Ticker?pair=${pair}`)
    if (result === null) return null
    const key = resultKey(result)
    const t = key !== undefined ? (result[key] as {c?: unknown[]} | undefined) : undefined
    const last = Array.isArray(t?.c) ? Number(t.c[0]) : Number.NaN
    return Number.isFinite(last) ? last : null
  }

  return {majorFiatSeries, majorFiatSpot}
}
