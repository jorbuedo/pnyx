/**
 * Token-prices cache table — a GLOBAL, wallet-independent store of the latest
 * known prices, keyed by `(network, cacheKey)`.
 *
 * Like {@link ./token-metadata-table} it is a property of the *market*, not the
 * holder: a token's ADA spot and the ADA→fiat quote are the same for every
 * wallet, so they are fetched once and reused across accounts and re-syncs.
 *
 * The value space is generic (`value` is a plain number) so one table backs
 * both price shapes the app caches; the consumer owns the `cacheKey` scheme
 * (`app/src/services/cardano-assets/price-cache.ts` prefixes token
 * spots with `spot:` and ADA→fiat quotes with `adafiat:`). `fetchedAt` lets the
 * consumer apply its own staleness TTL — prices are volatile, so unlike
 * immutable token metadata they are treated as a time-boxed prefill, not a
 * permanent cache.
 *
 * Adapters:
 *  - {@link ExpoSQLiteTokenPricesTable} – native (iOS / Android)
 *  - {@link IndexedDBTokenPricesTable}  – web / extension
 *  - {@link MemoryTokenPricesTable}     – in-process for tests
 *
 * @module
 */

import {Context, type Effect} from 'effect'
import type {StoreErrors} from './errors.js'

/** Bumped when the row shape / columns / indexes change → DROP+RECREATE on open. */
export const TOKEN_PRICES_TABLE_SCHEMA_VERSION = 1

/**
 * One cached price. Global identity is `(network, cacheKey)` — no wallet/account
 * partition. `value` is the raw numeric price (currency-independent token→ADA
 * spot, or an ADA→fiat rate); `cacheKey` disambiguates which.
 */
export type TokenPriceRow = {
  /** `mainnet` | `testnet` — prices differ per network. */
  readonly network: string
  /** Opaque cache key (owned by the consumer, e.g. `spot:<unit>` / `adafiat:<currency>`). */
  readonly cacheKey: string
  /** The cached numeric price. */
  readonly value: number
  /** Unix ms when fetched — the consumer applies its own staleness TTL. */
  readonly fetchedAt: number
}

/**
 * Token-prices table interface.
 *
 * Writes:
 *  - `putMany` upserts rows by `(network, cacheKey)`.
 *
 * Reads:
 *  - `getMany` returns the cached rows for the given `(network, cacheKeys)` —
 *    the caller diffs against its requested set to find cache misses.
 *
 * Lifecycle: `clear` wipes a network's rows; `close` releases the connection.
 */
export type TokenPricesTable = {
  readonly putMany: (rows: ReadonlyArray<TokenPriceRow>) => Effect.Effect<void, StoreErrors>
  readonly getMany: (
    network: string,
    cacheKeys: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<TokenPriceRow>, StoreErrors>
  readonly clear: (network: string) => Effect.Effect<void, StoreErrors>
  readonly close: () => Effect.Effect<void, StoreErrors>
}

/** Effect Service tag for dependency injection. */
export class TokenPricesTableService extends Context.Tag('TokenPricesTableService')<
  TokenPricesTableService,
  TokenPricesTable
>() {}
