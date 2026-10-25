/**
 * Price-point cache table — a GLOBAL, wallet-independent time-series of price
 * points keyed by `(network, seriesKey, tsBucket)`.
 *
 * Prices are a property of the *market*, not the holder, so this is shared
 * across every wallet (like {@link ./token-metadata-table} / token-prices).
 * Unlike the single-value token-prices table, this stores a **series**: many
 * rows per `seriesKey`, one per time bucket. `seriesKey` is opaque to the store
 * — the consumer names series (e.g. `adafiat:USD` for ADA→USD, `tokenada:<unit>`
 * for a token's ADA price). Historical points are **immutable**, so a cold read
 * never needs a refetch; only the recent tip changes.
 *
 * Adapters:
 *  - {@link ExpoSQLitePricePointTable} – native (iOS / Android)
 *  - {@link IndexedDBPricePointTable}  – web / extension
 *  - {@link MemoryPricePointTable}     – in-process for tests
 *
 * @module
 */

import {Context, type Effect} from 'effect'
import type {StoreErrors} from './errors.js'

/** Bumped when the row shape / columns / indexes change → DROP+RECREATE on open. */
export const PRICE_POINT_TABLE_SCHEMA_VERSION = 1

/**
 * One price point. Identity is `(network, seriesKey, tsBucket)`.
 * `tsBucket` is a unix-seconds timestamp floored to the consumer's bucket size.
 */
export type PricePointRow = {
  /** `mainnet` | `testnet`. */
  readonly network: string
  /** Opaque series id (consumer-owned, e.g. `adafiat:USD` / `tokenada:<unit>`). */
  readonly seriesKey: string
  /** Unix seconds, floored to the bucket. */
  readonly tsBucket: number
  /** The price value at that bucket (USD or ADA per the series). */
  readonly value: number
  /** Origin (`kraken` | `steelswap` | `bundled` | …) for audit / provenance. */
  readonly source: string
}

/**
 * Price-point table interface.
 *
 * Writes: `putMany` upserts rows by `(network, seriesKey, tsBucket)`.
 * Reads: `getRange` returns a series' points within `[fromTsBucket, toTsBucket]`
 *   inclusive, ascending by `tsBucket`.
 * Maintenance: `prune` deletes a series' points older than `beforeTsBucket`
 *   (the monthly downsample/cleanup calls this after writing coarser points);
 *   `clear` wipes a network; `close` releases the connection.
 */
export type PricePointTable = {
  readonly putMany: (rows: ReadonlyArray<PricePointRow>) => Effect.Effect<void, StoreErrors>
  readonly getRange: (
    network: string,
    seriesKey: string,
    fromTsBucket: number,
    toTsBucket: number,
  ) => Effect.Effect<ReadonlyArray<PricePointRow>, StoreErrors>
  readonly prune: (network: string, seriesKey: string, beforeTsBucket: number) => Effect.Effect<void, StoreErrors>
  readonly clear: (network: string) => Effect.Effect<void, StoreErrors>
  readonly close: () => Effect.Effect<void, StoreErrors>
}

/** Effect Service tag for dependency injection. */
export class PricePointTableService extends Context.Tag('PricePointTableService')<
  PricePointTableService,
  PricePointTable
>() {}
