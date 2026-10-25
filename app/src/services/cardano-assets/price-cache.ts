/**
 * Price cache shared across every `useAssetFiat` instance and the portfolio
 * enrichment — a two-tier cache over SteelSwap:
 *
 * - **In-memory (RAM)** — authoritative for {@link FRESH_MS}. Dedupes in-flight
 *   requests (a second caller for a value already being fetched awaits the same
 *   promise), which keeps SteelSwap's public-tier rate limit happy when many
 *   rows mount at once.
 * - **Persisted (SQLite, via {@link ./price-store})** — durable backing usable
 *   for {@link PERSIST_MS}. A cold boot recomputes balances from the last known
 *   prices with no network wait; a persisted hit older than {@link REFRESH_MS}
 *   but within {@link PERSIST_MS} is served immediately and refreshed in the
 *   background so it converges to fresh. Younger than that and **no request is
 *   made at all** — the stored price is simply good enough. When no store is
 *   bound (tests, or before app init) the cache is RAM-only.
 *
 * Two value shapes:
 * - **ADA→fiat** depends on the fiat currency but not the token → keyed by
 *   currency. A token's fiat price = spot(ADA) × ADA→fiat, composed by the caller.
 * - **token→ADA spot** is currency-independent → keyed by unit.
 *
 * @module
 */

import type {PricePointRow} from '@pnyx/store/price-point-table'
import {Effect, Exit} from 'effect'
import {networkCapabilities} from '../../config/network-capabilities'
import {logger} from '../../logger'
import type {FiatCurrency} from '../../providers/fiat-currencies'
import {failureOf} from '../../utils/effect-failure'
import {readSeriesRange, writeSeriesPoints} from '../price-history/price-point-store'
import {tokenAdaSeriesKey} from '../price-history/range'
import type {CardanoAssetsConfig} from './config'
import {fetchAdaPrice} from './price'
import {readPersistedPrices, writePersistedPrices} from './price-store'
import {fetchTokenAdaPrices, restoreSteelswapBackoff, steelswapBackingOff} from './steelswap'
import type {FetchLike} from './token-metadata'

/** RAM freshness — within this a cached value is served without any lookup. */
const FRESH_MS = 60_000
/**
 * Age at which a *usable* persisted price is worth spending a request to refresh.
 *
 * Deliberately NOT `FRESH_MS`. `FRESH_MS` governs in-process dedupe, and the RAM
 * cache starts empty every launch — so gating the background refresh on it meant
 * **every app start (or web reload) fired a SteelSwap request** as soon as the
 * stored price was a minute old, which it essentially always is. SteelSwap meters
 * a *daily quota* shared across every `/api/v2/*` endpoint, so those refreshes
 * were spending the same budget as swap estimates and orders: a day of
 * dev-driving exhausted the quota and took swap down with it.
 *
 * Half the usable window, so a price is served from disk with no request at all
 * for the first five minutes, and still refreshes well before it stops being
 * usable — the blocking path is never reached in normal use.
 */
const REFRESH_MS = 300_000
/** Persisted usable window — a stored price newer than this is served without a
 * network round-trip (older-than-`REFRESH_MS` hits are refreshed in background). */
const PERSIST_MS = 600_000
/**
 * Persisted usable window while SteelSwap is parked behind a 429.
 *
 * A stale spot beats no spot by a wide margin: without one a holding loses its
 * fiat line *and* drops out of the portfolio total silently, so the balance
 * under-reports with no indication anything is missing. The price is on disk
 * either way — refusing to read it does not make the total more truthful. Still
 * bounded, so a genuinely abandoned price eventually expires rather than
 * haunting the wallet forever.
 */
const PERSIST_BACKOFF_MS = 24 * 3600_000

/** How old a persisted spot may be right now, given the upstream's state. */
const persistWindowMs = (nowMs: number): number => (steelswapBackingOff(nowMs) ? PERSIST_BACKOFF_MS : PERSIST_MS)

/** Persisted cache-key namespaces (the store is a generic `(network, key)→value`). */
const spotKey = (unit: string): string => `spot:${unit}`
const adaFiatKey = (currency: string): string => `adafiat:${currency}`

type Entry<T> = {readonly at: number; readonly value: T}

const adaFiatByCurrency = new Map<string, Entry<number | null>>()
const adaFiatInflight = new Map<string, Promise<number | null>>()

const tokenAdaByUnit = new Map<string, Entry<number>>()
const tokenAdaInflight = new Map<string, Promise<number | null>>()

/** Reset the RAM caches (tests). Does not touch the persisted store. */
export const clearPriceCache = (): void => {
  adaFiatByCurrency.clear()
  adaFiatInflight.clear()
  tokenAdaByUnit.clear()
  tokenAdaInflight.clear()
}

/** Fetch ADA→fiat from the network, then update RAM + persist (best-effort). */
const fetchAdaAndStore = async (
  currency: FiatCurrency,
  nowMs: number,
  config: CardanoAssetsConfig,
  fetchImpl?: FetchLike,
): Promise<number | null> => {
  const value = await Effect.runPromise(
    fetchImpl !== undefined
      ? fetchAdaPrice(currency, nowMs, config, fetchImpl)
      : fetchAdaPrice(currency, nowMs, config),
  ).catch((e) => {
    logger.warn('ADA price fetch failed; the rate stays unpriced for this read', {
      origin: 'CardanoPriceCache',
      currency,
      error: String(e),
    })
    return null
  })
  // Only cache/persist a real rate — a transient `null` would poison every
  // reader for the whole TTL and paint an all-unpriced portfolio.
  if (value !== null) {
    adaFiatByCurrency.set(currency, {at: nowMs, value})
    void writePersistedPrices(config.network, [{cacheKey: adaFiatKey(currency), value, fetchedAt: nowMs}])
  }
  return value
}

/** Fetch token→ADA spots from the network, then update RAM + persist. */
const fetchSpotsAndStore = async (
  units: readonly string[],
  nowMs: number,
  config: CardanoAssetsConfig,
  fetchImpl?: FetchLike,
): Promise<ReadonlyMap<string, number>> => {
  // ⚠️ **Parked means parked.** The client refuses a throttled call locally, so re-firing every round
  // only produced a warning per round for hours (`steelswap backoff 21627s` — the six-hour clamp). The
  // callers below already widen their persisted window while this holds, so skipping the call changes
  // no data; it removes a warning that repeats until the deadline passes.
  // A deadline set before this process started still applies — see `restoreSteelswapBackoff`. Awaited
  // here, on the one path that is about to make the call, rather than wired into app startup where it
  // would be one more thing to forget.
  await restoreSteelswapBackoff(nowMs)
  if (steelswapBackingOff(nowMs)) {
    logger.debug('SteelSwap is parked; keeping the persisted spots this round', {
      origin: 'CardanoPriceCache',
      unitCount: units.length,
    })
    return new Map<string, number>()
  }

  // ⚠️ `runPromiseExit`, not `runPromise().catch()`. A rejected `runPromise` throws a `FiberFailure`
  // whose message is a rendered summary with a stack, so the typed error's `reason` — the field that
  // says *why* SteelSwap refused — is already gone by the time a `catch` sees it. That is why every
  // chart on a 54-token wallet reported `SteelswapError` and nothing more.
  const exit = await Effect.runPromiseExit(
    fetchImpl !== undefined
      ? fetchTokenAdaPrices(units, config, nowMs, fetchImpl)
      : fetchTokenAdaPrices(units, config, nowMs),
  )
  const map = Exit.isSuccess(exit)
    ? exit.value
    : (() => {
        const failure = failureOf(exit.cause)
        logger.warn('Token price fetch failed; no live spots this round', {
          origin: 'CardanoPriceCache',
          unitCount: units.length,
          kind: failure.kind,
          error: failure.reason,
        })
        return new Map<string, number>()
      })()
  const persist: Array<{cacheKey: string; value: number; fetchedAt: number}> = []
  // Every live spot also seeds the token→ADA history. That history is the
  // resilience fallback below, and it used to be written only by the chart's
  // OHLCV call — the same throttled host — so on the first rate-limit there was
  // nothing to fall back to, which is exactly when it is needed. This call runs
  // on every portfolio load, so the series self-seeds from the cheap path.
  const points: PricePointRow[] = []
  for (const unit of units) {
    const v = map.get(unit)
    if (v !== undefined) {
      tokenAdaByUnit.set(unit, {at: nowMs, value: v})
      persist.push({cacheKey: spotKey(unit), value: v, fetchedAt: nowMs})
      points.push({
        network: config.network,
        seriesKey: tokenAdaSeriesKey(unit),
        tsBucket: Math.floor(nowMs / 1000),
        value: v,
        source: 'steelswap',
      })
    }
  }
  void writePersistedPrices(config.network, persist)
  void writeSeriesPoints(points)
  return map
}

/**
 * ADA unit price in `currency`, shared+cached per currency. Concurrent callers
 * for the same currency share one in-flight request; a persisted price within
 * {@link PERSIST_MS} resolves without a network round-trip.
 */
export const getAdaFiat = (
  currency: FiatCurrency,
  nowMs: number,
  config: CardanoAssetsConfig,
  fetchImpl?: FetchLike,
): Promise<number | null> => {
  // Test funds have no market: there is no price to fetch, and pricing tADA off
  // the mainnet feed would be a made-up number.
  if (!networkCapabilities(config.network).showFiat) return Promise.resolve(null)
  const hit = adaFiatByCurrency.get(currency)
  if (hit !== undefined && nowMs - hit.at < FRESH_MS) return Promise.resolve(hit.value)
  const inflight = adaFiatInflight.get(currency)
  if (inflight !== undefined) return inflight

  const promise = (async () => {
    const persisted = await readPersistedPrices(config.network, [adaFiatKey(currency)])
    const p = persisted.get(adaFiatKey(currency))
    if (p !== undefined && nowMs - p.fetchedAt < PERSIST_MS) {
      adaFiatByCurrency.set(currency, {at: p.fetchedAt, value: p.value})
      // Usable, and old enough to be worth a request → refresh in the background.
      if (nowMs - p.fetchedAt >= REFRESH_MS) void fetchAdaAndStore(currency, nowMs, config, fetchImpl)
      return p.value
    }
    return fetchAdaAndStore(currency, nowMs, config, fetchImpl)
  })()
    .catch((e) => {
      logger.warn('ADA fiat rate could not be resolved', {
        origin: 'CardanoPriceCache',
        currency,
        error: String(e),
      })
      return null
    })
    .finally(() => adaFiatInflight.delete(currency))
  adaFiatInflight.set(currency, promise)
  return promise
}

/**
 * Token→ADA spot for each unit, shared+cached per unit (currency-independent).
 * RAM-fresh units resolve immediately; in-flight units await the existing
 * request; the rest resolve from the persisted store (within {@link PERSIST_MS})
 * or one batched network fetch. Unpriced units are absent from the result.
 */
export const getTokenAdaSpots = async (
  units: readonly string[],
  nowMs: number,
  config: CardanoAssetsConfig,
  fetchImpl?: FetchLike,
): Promise<ReadonlyMap<string, number>> => {
  // See getAdaFiat: no price feed covers testnet assets.
  if (!networkCapabilities(config.network).showFiat) return new Map()
  const out = new Map<string, number>()
  const pending: Array<Promise<void>> = []
  const missing: string[] = []

  for (const unit of new Set(units)) {
    if (unit.length === 0) continue
    const hit = tokenAdaByUnit.get(unit)
    if (hit !== undefined && nowMs - hit.at < FRESH_MS) {
      out.set(unit, hit.value)
      continue
    }
    const inflight = tokenAdaInflight.get(unit)
    if (inflight !== undefined) {
      pending.push(
        inflight.then((v) => {
          if (v !== null) out.set(unit, v)
        }),
      )
      continue
    }
    missing.push(unit)
  }

  if (missing.length > 0) {
    // Persisted-then-network resolution for the whole missing set, created
    // synchronously so the in-flight registration below dedupes concurrent
    // callers for the same unit.
    const batch = (async () => {
      const persisted = await readPersistedPrices(config.network, missing.map(spotKey))
      const result = new Map<string, number>()
      const stillMissing: string[] = []
      const staleRefresh: string[] = []
      const usableMs = persistWindowMs(nowMs)
      for (const unit of missing) {
        const p = persisted.get(spotKey(unit))
        if (p !== undefined && nowMs - p.fetchedAt < usableMs) {
          result.set(unit, p.value)
          tokenAdaByUnit.set(unit, {at: p.fetchedAt, value: p.value})
          if (nowMs - p.fetchedAt >= REFRESH_MS) staleRefresh.push(unit)
        } else {
          stillMissing.push(unit)
        }
      }
      if (stillMissing.length > 0) {
        const fetched = await fetchSpotsAndStore(stillMissing, nowMs, config, fetchImpl)
        for (const unit of stillMissing) {
          const v = fetched.get(unit)
          if (v !== undefined) result.set(unit, v)
        }
      }
      if (staleRefresh.length > 0) void fetchSpotsAndStore(staleRefresh, nowMs, config, fetchImpl)
      return result
    })()
    // Register each requested unit as in-flight so a concurrent caller reuses
    // this batch instead of firing its own.
    for (const unit of missing) {
      tokenAdaInflight.set(
        unit,
        batch.then((map) => map.get(unit) ?? null).finally(() => tokenAdaInflight.delete(unit)),
      )
    }
    const map = await batch
    for (const unit of missing) {
      const v = map.get(unit)
      if (v !== undefined) out.set(unit, v)
    }
  }

  await Promise.all(pending)

  // Resilience fallback: for units the current-price path couldn't resolve
  // (e.g. SteelSwap throttled / backing off), use the latest token→ADA close
  // from the persisted price-point history. It's slightly stale but keeps token
  // fiat alive through a rate-limit instead of blanking it.
  let unresolved = [...new Set(units)].filter((u) => u.length > 0 && !out.has(u))

  // The fetch above is what *sets* the backoff, so the persisted read earlier in
  // this call still used the narrow window. Re-check it now that we know the
  // upstream is unreachable — a spot on disk beats the older series tip, and
  // beats blanking the holding outright. Gated on the backoff deliberately: when
  // SteelSwap is answering and simply has no price for a token (delisted), that
  // absence is the truth and must not be papered over with yesterday's number.
  if (unresolved.length > 0 && steelswapBackingOff(nowMs)) {
    const persisted = await readPersistedPrices(config.network, unresolved.map(spotKey))
    for (const unit of unresolved) {
      const p = persisted.get(spotKey(unit))
      if (p !== undefined && nowMs - p.fetchedAt < PERSIST_BACKOFF_MS) out.set(unit, p.value)
    }
    unresolved = unresolved.filter((u) => !out.has(u))
  }

  if (unresolved.length > 0) {
    const nowBucket = Math.floor(nowMs / 1000)
    const fromBucket = nowBucket - 90 * 86400
    await Promise.all(
      unresolved.map(async (unit) => {
        const rows = await readSeriesRange(config.network, tokenAdaSeriesKey(unit), fromBucket, nowBucket)
        const tip = rows[rows.length - 1]
        if (tip !== undefined) out.set(unit, tip.value)
      }),
    )
  }
  return out
}
