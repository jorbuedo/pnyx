/**
 * SteelSwap v2 client: token metadata, token→ADA prices, and the ADA→fiat
 * quote, over the anon-keyed `/api/v2/*` surface; plus the keyless token-icon
 * URL. All requests carry a bearer key — the Pnyx partner key when the build has
 * one, otherwise the per-install CIP-8 key, which is the only one a 401 retries
 * (the partner key cannot be re-minted from the app). Batched endpoints chunk at SteelSwap's documented max of 100
 * units. Every function fails with {@link SteelswapError} on transport/parse
 * trouble — callers degrade to absent (unknown metadata / no price), never a
 * fabricated value.
 *
 * Units are SteelSwap's concatenated `policyId+assetNameHex` form (see
 * `asset-id.ts`); ADA is the empty unit `''` and is never sent to the API.
 *
 * @module
 */

import {Data, Effect} from 'effect'
import {logger} from '../../logger'
import {storage} from '../../platform/storage'
import type {CardanoAssetsConfig} from './config'
import {invalidateSteelswapKey, steelswapAuthHeaders} from './steelswap-auth'
import type {FetchLike} from './token-metadata'

/**
 * A failed SteelSwap call.
 *
 * `reason` stays the human/log string every existing caller reads. `code` and
 * `status` carry the machine vocabulary of the V2 flat error body
 * (`{error, message, …camelCase context}`) so a caller can branch on
 * `no_route` / `quote_changed` / `chain_unavailable` instead of substring-matching
 * the reason — which is how a message change silently disables a retry.
 * `body` is the whole parsed body, for the extra context a code carries
 * (`quote_changed` ships the fresh quote).
 *
 * ⚠️ The TapTools-compatible routes answer with the upstream `{"detail": …}`
 * shape instead, which carries no code — `code` is `null` for those.
 */
export class SteelswapError extends Data.TaggedError('SteelswapError')<{
  readonly reason: string
  readonly code?: string | null
  readonly status?: number | null
  readonly body?: Record<string, unknown> | null
}> {}

/** SteelSwap's documented batch cap for units per request. */
const MAX_UNITS_PER_REQUEST = 100

const defaultFetch: FetchLike = (url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<FetchLike>

const chunk = <T>(items: readonly T[], size: number): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

// 429 backoff: when the key is throttled, park ALL SteelSwap calls until the
// window passes. Re-firing while throttled only deepens the lockout (each 429
// resets the counter), so we short-circuit — callers already degrade to cached
// data. One host, so one shared deadline.
let backoffUntilMs = 0
const MAX_BACKOFF_MS = 6 * 3600_000
const DEFAULT_BACKOFF_MS = 60_000
const BACKOFF_STORAGE_KEY = '@pnyx/steelswap:backoff-until'

/**
 * ⚠️ **The deadline is persisted, because a restart is what most often re-triggers it.**
 *
 * This was process state, cleared on every app load — and the comment above says why that is worse
 * than it sounds: "re-firing while throttled only deepens the lockout (each 429 resets the counter)".
 * A cold start fires a whole portfolio's price and OHLCV volley at once (54 units plus one request per
 * held token, measured), so every restart bought a deeper lockout, invisibly. Observed after a day of
 * restarts: `steelswap backoff 21627s` — the six-hour clamp, i.e. the worst case this code allows.
 *
 * Restoring it costs a stale deadline at worst; `resetSteelswapBackoff` is still there for a user who
 * asks to retry.
 */
const persistBackoff = (untilMs: number): void => {
  void storage.set(BACKOFF_STORAGE_KEY, String(untilMs)).catch((e: unknown) => {
    // Not fatal: the in-memory deadline still holds for this session. Said out loud because a silent
    // failure here means the next restart quietly re-hammers a throttled key.
    logger.warn('SteelSwap backoff could not be persisted; a restart will retry too early', {
      origin: 'steelswap',
      error: String(e),
    })
  })
}

/**
 * Bring back a deadline set before this process started. Idempotent; safe to call from anywhere that
 * is about to make a SteelSwap call.
 */
export const restoreSteelswapBackoff = async (nowMs: number = Date.now()): Promise<void> => {
  const raw = await storage.get(BACKOFF_STORAGE_KEY).catch((e: unknown) => {
    logger.debug('SteelSwap backoff could not be read; assuming none', {origin: 'steelswap', error: String(e)})
    return null
  })
  const until = raw === null ? 0 : Number(raw)
  if (!Number.isFinite(until) || until <= nowMs) return
  if (until <= backoffUntilMs) return
  backoffUntilMs = until
  logger.info('SteelSwap is still parked from a previous session', {
    origin: 'steelswap',
    secondsLeft: Math.ceil((until - nowMs) / 1000),
  })
}

/** Clear the SteelSwap 429 backoff (tests / a user-forced retry). */
export const resetSteelswapBackoff = (): void => {
  backoffUntilMs = 0
  persistBackoff(0)
}

/**
 * Whether the shared deadline is still parked. The price cache widens how old a
 * persisted spot may be while this holds: there is no live price to be had, so
 * refusing a stale one only blanks the holding.
 */
export const steelswapBackingOff = (nowMs: number): boolean => nowMs < backoffUntilMs

/** Park-duration from a 429's `Retry-After` (seconds or HTTP-date), clamped. */
const retryAfterMs = (response: {readonly headers?: {get(name: string): string | null}}, nowMs: number): number => {
  const h = response.headers?.get('retry-after')
  if (h != null && h.length > 0) {
    const secs = Number(h)
    if (Number.isFinite(secs) && secs > 0) return Math.min(secs * 1000, MAX_BACKOFF_MS)
    const date = Date.parse(h)
    if (Number.isFinite(date)) return Math.min(Math.max(date - nowMs, 0), MAX_BACKOFF_MS)
  }
  return DEFAULT_BACKOFF_MS
}

/**
 * One UNAUTHENTICATED request to a public SteelSwap route.
 *
 * Kept apart from {@link steelswapAuthedJson} on purpose: a public route must
 * not spend a request against the per-key daily quota, and must not be parked by
 * the shared 429 backoff — there is no key here to throttle, and the public
 * routes are the ones worth still having when the keyed ones are cut off.
 */
export const steelswapPublicJson = (
  config: CardanoAssetsConfig,
  path: string,
  fetchImpl: FetchLike,
): Effect.Effect<unknown, SteelswapError> =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () => fetchImpl(`${config.steelswapUrl}${path}`, {method: 'get', headers: {Accept: 'application/json'}}),
      catch: (e) => new SteelswapError({reason: e instanceof Error ? e.message : String(e)}),
    })
    if (!response.ok) {
      return yield* Effect.fail(new SteelswapError({reason: `${path} ${response.status}`, status: response.status}))
    }
    return yield* Effect.tryPromise({
      try: () => response.json(),
      catch: (e) => new SteelswapError({reason: e instanceof Error ? e.message : String(e)}),
    })
  })

/**
 * One authed request with a single 401-triggered re-mint+retry. Returns the
 * parsed JSON body; fails with {@link SteelswapError} on non-2xx or transport
 * error (after the retry). Exported so the swap client shares the exact same
 * anon-key + retry path.
 */
export const steelswapAuthedJson = (
  config: CardanoAssetsConfig,
  path: string,
  init: {method?: string; body?: string},
  nowMs: number,
  fetchImpl: FetchLike,
): Effect.Effect<unknown, SteelswapError> =>
  Effect.gen(function* () {
    // Throttled — don't touch the network; the caller serves cached data.
    if (nowMs < backoffUntilMs) {
      return yield* Effect.fail(
        new SteelswapError({reason: `steelswap backoff ${Math.ceil((backoffUntilMs - nowMs) / 1000)}s`}),
      )
    }

    // Headers rather than a key: an endpoint that injects the credential wants NO `authorization`
    // at all, and an empty string or a placeholder would authenticate as nothing rather than as us.
    const send = (auth: Record<string, string>) =>
      Effect.tryPromise({
        try: () =>
          fetchImpl(`${config.steelswapUrl}${path}`, {
            method: init.method ?? 'get',
            headers: {
              Accept: 'application/json',
              ...auth,
              ...(init.body !== undefined ? {'Content-Type': 'application/json'} : {}),
            },
            ...(init.body !== undefined ? {body: init.body} : {}),
          }),
        catch: (e) => new SteelswapError({reason: e instanceof Error ? e.message : String(e)}),
      })

    const auth = yield* steelswapAuthHeaders(config, fetchImpl).pipe(
      Effect.mapError((e) => new SteelswapError({reason: e.reason})),
    )
    let response = yield* send(auth)
    // Re-mint and retry only when there is something to re-mint. With the partner key there is not:
    // it is issued out-of-band, so a second attempt would send the same rejected credential and the
    // only honest move is to report the 401 the caller already has.
    if (response.status === 401 && invalidateSteelswapKey(config)) {
      const fresh = yield* steelswapAuthHeaders(config, fetchImpl).pipe(
        Effect.mapError((e) => new SteelswapError({reason: e.reason})),
      )
      response = yield* send(fresh)
    }
    if (response.status === 429) {
      backoffUntilMs = nowMs + retryAfterMs(response, nowMs)
      persistBackoff(backoffUntilMs)
      return yield* Effect.fail(new SteelswapError({reason: `${path} 429 — backing off`}))
    }
    if (!response.ok) {
      // Read the flat error body so callers can branch on the machine code.
      // A body that will not parse is not itself an error — the status is still
      // the fact we report — but it is logged, because a route answering
      // non-JSON is worth knowing about.
      const errBody = yield* Effect.tryPromise({
        try: async () => (await response.json()) as unknown,
        catch: (e) => new SteelswapError({reason: e instanceof Error ? e.message : String(e)}),
      }).pipe(
        Effect.catchAll((e) => {
          logger.debug('SteelSwap error body was not JSON', {origin: 'steelswap', path, error: e.reason})
          return Effect.succeed(null)
        }),
      )
      const parsed = errBody !== null && typeof errBody === 'object' ? (errBody as Record<string, unknown>) : null
      const code = typeof parsed?.error === 'string' ? parsed.error : null
      return yield* Effect.fail(
        new SteelswapError({
          reason: `${path} ${response.status}${code === null ? '' : ` ${code}`}`,
          code,
          status: response.status,
          body: parsed,
        }),
      )
    }
    return yield* Effect.tryPromise({
      try: () => response.json(),
      catch: (e) => new SteelswapError({reason: e instanceof Error ? e.message : String(e)}),
    })
  })

/** Metadata for one token, keyed by SteelSwap unit. Absent fields stay `null` — never fabricated. */
export type SteelswapTokenMeta = {
  readonly unit: string
  /** `null` when SteelSwap reports decimals as unknown (`decimalsKnown === false`). */
  readonly decimals: number | null
  readonly ticker: string | null
  readonly name: string | null
  /** True when SteelSwap has a logo for the token (`logoUrl` present) — the
   * synchronous "has icon" signal the icon endpoint will serve. */
  readonly hasIcon: boolean
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)

const parseMetaRow = (row: unknown): SteelswapTokenMeta | null => {
  if (row === null || typeof row !== 'object') return null
  const r = row as Record<string, unknown>
  const unit = str(r.unit)
  if (unit === null) return null
  const decimalsKnown = r.decimalsKnown === true
  const decimals = decimalsKnown && typeof r.decimals === 'number' && r.decimals >= 0 ? r.decimals : null
  return {unit, decimals, ticker: str(r.ticker), name: str(r.name), hasIcon: str(r.logoUrl) !== null}
}

/**
 * Batch token metadata (`POST /api/v2/tokens/metadata`). Returns a map keyed by
 * unit; units SteelSwap doesn't know are simply absent from the map.
 */
export const fetchMetadata = (
  units: readonly string[],
  config: CardanoAssetsConfig,
  nowMs: number,
  fetchImpl: FetchLike = defaultFetch,
): Effect.Effect<ReadonlyMap<string, SteelswapTokenMeta>, SteelswapError> =>
  Effect.gen(function* () {
    const out = new Map<string, SteelswapTokenMeta>()
    const wanted = [...new Set(units.filter((u) => u.length > 0))]
    for (const batch of chunk(wanted, MAX_UNITS_PER_REQUEST)) {
      const body = yield* steelswapAuthedJson(
        config,
        '/api/v2/tokens/metadata',
        {method: 'post', body: JSON.stringify({units: batch})},
        nowMs,
        fetchImpl,
      )
      const tokens = (body as {tokens?: unknown}).tokens
      if (!Array.isArray(tokens)) continue
      for (const row of tokens) {
        const meta = parseMetaRow(row)
        if (meta !== null) out.set(meta.unit, meta)
      }
    }
    return out
  })

/**
 * Batch token spot price in ADA (`POST /api/v2/taptools/token/prices`). Returns
 * a map `unit → adaPrice`; unpriced units are absent (caller treats as no price).
 */
export const fetchTokenAdaPrices = (
  units: readonly string[],
  config: CardanoAssetsConfig,
  nowMs: number,
  fetchImpl: FetchLike = defaultFetch,
): Effect.Effect<ReadonlyMap<string, number>, SteelswapError> =>
  Effect.gen(function* () {
    const out = new Map<string, number>()
    const wanted = [...new Set(units.filter((u) => u.length > 0))]
    for (const batch of chunk(wanted, MAX_UNITS_PER_REQUEST)) {
      const body = yield* steelswapAuthedJson(
        config,
        '/api/v2/taptools/token/prices',
        {method: 'post', body: JSON.stringify(batch)},
        nowMs,
        fetchImpl,
      )
      if (body === null || typeof body !== 'object') continue
      for (const [unit, price] of Object.entries(body as Record<string, unknown>)) {
        if (typeof price === 'number' && Number.isFinite(price)) out.set(unit, price)
      }
    }
    return out
  })

/** A SteelSwap resolution (`5m`/`15m`/`30m`/`1h`/`4h`/`1d`/`1w`) in milliseconds, or `null`. */
const intervalMs = (interval: string): number | null => {
  const m = /^(\d+)([mhdw])$/.exec(interval.trim())
  if (m === null) return null
  const n = Number(m[1])
  const unit = {m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000}[m[2] ?? '']
  return unit === undefined || !Number.isFinite(n) || n <= 0 ? null : n * unit
}

/**
 * How long a candle series may be served from memory.
 *
 * ⚠️ **There was no cache at all**: the same 365 daily candles for the same token were
 * fetched **~65 times in one session**, identical query string every time. A closed
 * candle is final, so the only moving part is the open one — but "serve until the day
 * rolls over" would freeze today's candle for hours, so the bound is the smaller of the
 * candle width and this. A 1d series refreshes every five minutes instead of on every
 * render; a 5m series is unaffected.
 */
const MAX_OHLCV_TTL_MS = 5 * 60_000

type OhlcvEntry = {readonly at: number; readonly series: ReadonlyArray<{readonly ts: number; readonly value: number}>}

/** Cached series per (network, unit, interval, count). */
const ohlcvCache = new Map<string, OhlcvEntry>()

/** Drop every cached candle series — tests, and a network change. */
export const resetOhlcvCache = (): void => {
  ohlcvCache.clear()
}

/**
 * Token→ADA OHLCV history (`GET /api/v2/taptools/token/ohlcv`). Returns the
 * **close** (token price in ADA) per candle, ascending by `ts` (unix seconds).
 * `interval` is a SteelSwap resolution (`5m`/`15m`/`30m`/`1h`/`4h`/`1d`/`1w`);
 * `numIntervals` candles back from now. Empty for ADA / unknown units / no data.
 */
export const fetchTokenAdaOhlcv = (
  unit: string,
  interval: string,
  numIntervals: number,
  config: CardanoAssetsConfig,
  nowMs: number,
  fetchImpl: FetchLike = defaultFetch,
): Effect.Effect<ReadonlyArray<{readonly ts: number; readonly value: number}>, SteelswapError> =>
  Effect.gen(function* () {
    if (unit.length === 0 || numIntervals <= 0) return []
    const cacheKey = `${config.network}/${unit}/${interval}/${numIntervals}`
    const cached = ohlcvCache.get(cacheKey)
    const ttl = Math.min(intervalMs(interval) ?? MAX_OHLCV_TTL_MS, MAX_OHLCV_TTL_MS)
    if (cached !== undefined && nowMs - cached.at < ttl && nowMs >= cached.at) return cached.series
    const body = yield* steelswapAuthedJson(
      config,
      `/api/v2/taptools/token/ohlcv?interval=${encodeURIComponent(interval)}&unit=${unit}&numIntervals=${numIntervals}`,
      {},
      nowMs,
      fetchImpl,
    )
    if (!Array.isArray(body)) return []
    const out: Array<{ts: number; value: number}> = []
    for (const row of body) {
      if (row === null || typeof row !== 'object') continue
      const r = row as {time?: unknown; close?: unknown}
      const ts = Number(r.time)
      const close = Number(r.close)
      if (Number.isFinite(ts) && Number.isFinite(close)) out.push({ts, value: close})
    }
    const series = out.sort((a, b) => a.ts - b.ts)
    // ⚠️ An empty answer is cached too. "No candles for this token" is a real answer and
    // re-asking for it every render is exactly the waste this exists to stop; the TTL
    // still bounds how long a newly-listed token stays invisible.
    ohlcvCache.set(cacheKey, {at: nowMs, series})
    return series
  })

/**
 * ADA unit price in `quoteCurrency` (`GET /api/v2/taptools/token/quote`).
 * `quoteCurrency` must be one SteelSwap supports (ADA/USD/EUR/BTC/ETH — see
 * `steelswapQuoteCurrency`). Returns `null` when the response has no finite price.
 */
export const fetchAdaQuote = (
  quoteCurrency: string,
  config: CardanoAssetsConfig,
  nowMs: number,
  fetchImpl: FetchLike = defaultFetch,
): Effect.Effect<number | null, SteelswapError> =>
  Effect.gen(function* () {
    const body = yield* steelswapAuthedJson(
      config,
      `/api/v2/taptools/token/quote?quote=${encodeURIComponent(quoteCurrency)}`,
      {},
      nowMs,
      fetchImpl,
    )
    const price = (body as {price?: unknown}).price
    return typeof price === 'number' && Number.isFinite(price) ? price : null
  })

/**
 * Keyless token-icon URL (`GET /tokens/icon/{unit}/`) — a full-resolution PNG
 * behind a CDN. Returns `null` for ADA / empty unit. Downscaling + caching is
 * the icon-cache layer's job (`token-icon-cache`), not this URL builder.
 */
export const tokenIconUrl = (unit: string, config: CardanoAssetsConfig): string | null => {
  if (unit.length === 0) return null
  return `${config.steelswapUrl}/tokens/icon/${unit}/`
}
