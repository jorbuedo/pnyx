/**
 * Persisted backing for the price cache — a best-effort read-through over the
 * `@pnyx/store` token-prices-table so token→ADA spots and ADA→fiat quotes
 * survive across sessions (a cold boot recomputes balances from cached prices
 * instead of waiting on the network). Bound once at app init
 * (`setCardanoAssetsPriceStore`, from `wallet-service`, the same module-level
 * pattern `token-store.ts` uses); when unbound the price cache stays
 * RAM-only and behaves exactly as before.
 *
 * Unlike token metadata (immutable → cached forever), prices are volatile, so
 * the consumer ({@link ./price-cache}) applies a staleness TTL on `fetchedAt`.
 *
 * @module
 */

import type {TokenPriceRow, TokenPricesTable} from '@pnyx/store/token-prices-table'
import {Effect} from 'effect'
import {logger} from '../../logger'

let table: TokenPricesTable | null = null

/** Bind the persisted token-prices table. Called once at app init. */
export const setCardanoAssetsPriceStore = (t: TokenPricesTable): void => {
  table = t
}

/** Clear the binding (tests). */
export const clearCardanoAssetsPriceStore = (): void => {
  table = null
}

export type PersistedPrice = {readonly value: number; readonly fetchedAt: number}

/**
 * Read persisted prices for `cacheKeys`. Best-effort: returns an empty map when
 * no store is bound or the read fails (a cache is never a hard dependency).
 */
export const readPersistedPrices = async (
  network: string,
  cacheKeys: readonly string[],
): Promise<ReadonlyMap<string, PersistedPrice>> => {
  const store = table
  if (store === null || cacheKeys.length === 0) return new Map()
  const rows = await Effect.runPromise(
    store.getMany(network, cacheKeys).pipe(
      Effect.catchAll((e) => {
        logger.warn('Persisted price read failed; prices fall back to a live fetch', {
          origin: 'CardanoPriceStore',
          keyCount: cacheKeys.length,
          error: String(e),
        })
        return Effect.succeed([] as readonly TokenPriceRow[])
      }),
    ),
  )
  const out = new Map<string, PersistedPrice>()
  for (const r of rows) out.set(r.cacheKey, {value: r.value, fetchedAt: r.fetchedAt})
  return out
}

/** Upsert persisted prices. Best-effort — store failures are swallowed. */
export const writePersistedPrices = async (
  network: string,
  entries: readonly {readonly cacheKey: string; readonly value: number; readonly fetchedAt: number}[],
): Promise<void> => {
  const store = table
  if (store === null || entries.length === 0) return
  await Effect.runPromise(
    store.putMany(entries.map((e) => ({network, ...e}))).pipe(
      Effect.catchAll((e) => {
        logger.warn('Failed to persist prices', {
          origin: 'CardanoPriceStore',
          entryCount: entries.length,
          error: String(e),
        })
        return Effect.void
      }),
    ),
  )
}
