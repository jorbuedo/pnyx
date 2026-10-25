/**
 * Persisted backing for the price-history series — a best-effort read-through
 * over the `@pnyx/store` price-point-table so ADA/NIGHT→fiat (and, later,
 * token→ADA) history survives across sessions. Historical points are immutable,
 * so a warm read never needs a refetch; only the tip is re-pulled.
 *
 * Bound once at app init (`setPricePointStore`, from `wallet-service`, the same
 * module-level pattern `price-store.ts` / `token-store.ts` use); when unbound
 * the history hooks fetch live each time and skip persistence.
 *
 * @module
 */

import type {PricePointRow, PricePointTable} from '@pnyx/store/price-point-table'
import {Effect} from 'effect'
import {logger} from '../../logger'
import {retentionThin} from './retention'

let table: PricePointTable | null = null

/** Bind the persisted price-point table. Called once at app init. */
export const setPricePointStore = (t: PricePointTable): void => {
  table = t
}

/** Clear the binding (tests / network switch teardown). */
export const clearPricePointStore = (): void => {
  table = null
}

/**
 * Read a series' cached points within `[fromBucket, toBucket]` (inclusive,
 * ascending). Best-effort: empty when no store is bound or the read fails
 * (the cache is never a hard dependency — the hook falls back to the network).
 */
export const readSeriesRange = async (
  network: string,
  seriesKey: string,
  fromBucket: number,
  toBucket: number,
): Promise<readonly PricePointRow[]> => {
  const store = table
  if (store === null || toBucket < fromBucket) return []
  return Effect.runPromise(
    store.getRange(network, seriesKey, fromBucket, toBucket).pipe(
      Effect.catchAll((e) => {
        logger.warn('Price-point range read failed; the chart renders empty', {
          origin: 'PricePointStore',
          seriesKey,
          error: String(e),
        })
        return Effect.succeed([] as readonly PricePointRow[])
      }),
    ),
  )
}

/** Upsert points for a series. Best-effort — store failures are swallowed. */
export const writeSeriesPoints = async (rows: readonly PricePointRow[]): Promise<void> => {
  const store = table
  if (store === null || rows.length === 0) return
  await Effect.runPromise(
    store.putMany(rows).pipe(
      Effect.catchAll((e) => {
        logger.warn('Failed to persist price points', {
          origin: 'PricePointStore',
          rowCount: rows.length,
          error: String(e),
        })
        return Effect.void
      }),
    ),
  )
}

// Per-session gate — a series is downsampled at most once per process (the
// retention decision is a fixed point, so re-running is wasted work).
const prunedThisSession = new Set<string>()

/** Clear the prune gate (tests). */
export const clearPruneGate = (): void => prunedThisSession.clear()

/**
 * Downsample a series in place per the retention tiers (5-min ≤7d, hourly ≤90d,
 * daily older) — read the full series, thin it, and rewrite when that removes
 * points. Best-effort and at most once per series per session; a no-op when the
 * series is already thin or no store is bound. Call fire-and-forget after a load
 * so a frequently-viewed series can't grow unbounded.
 */
export const pruneSeries = async (network: string, seriesKey: string, nowSec: number): Promise<void> => {
  const store = table
  const gate = `${network}|${seriesKey}`
  if (store === null || prunedThisSession.has(gate)) return
  prunedThisSession.add(gate)

  const runOr = <A>(effect: Effect.Effect<A, unknown>, fallback: A, step: string): Promise<A> =>
    Effect.runPromise(
      effect.pipe(
        Effect.catchAll((e) => {
          logger.warn('Downsample step failed; continuing with the fallback', {
            origin: 'PricePointStore',
            seriesKey,
            step,
            error: String(e),
          })
          return Effect.succeed(fallback)
        }),
      ),
    )

  const rows = await runOr<readonly PricePointRow[]>(store.getRange(network, seriesKey, 0, nowSec), [], 'getRange')
  if (rows.length === 0) return
  const thinned = retentionThin(
    rows.map((r) => ({ts: r.tsBucket, value: r.value})),
    nowSec,
  )
  if (thinned.length >= rows.length) return // already at (or below) retention resolution

  const sourceOf = new Map(rows.map((r) => [r.tsBucket, r.source]))
  const rewritten: PricePointRow[] = thinned.map((p) => ({
    network,
    seriesKey,
    tsBucket: p.ts,
    value: p.value,
    source: sourceOf.get(p.ts) ?? 'kraken',
  }))
  // Delete every point of this series (bucket < now+1 day covers all), then
  // re-insert the thinned representatives.
  await runOr(store.prune(network, seriesKey, nowSec + 86400), undefined, 'prune')
  await runOr(store.putMany(rewritten), undefined, 'putMany')
}
