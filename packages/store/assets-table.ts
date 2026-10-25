/**
 * Portfolio-assets table — list-shaped, indexed storage for a wallet's
 * enriched portfolio assets (native + tokens + NFTs).
 *
 * Mirrors the design of the transactions + UTXO tables (same `Store` ↔ `Table`
 * separation, same schema-versioning model). Exists so the Portfolio screen
 * can paint cache-first on cold boot instead of waiting on the full
 * `getAssets` enrichment round-trip — which on a whale (tens of thousands of
 * token types) is ~100s. Sync writes the freshly-enriched set with
 * `replaceAll`; the screen reads `list` immediately on mount and refreshes in
 * the background.
 *
 * Like the transactions table, the full enriched asset rides in a `detailJson`
 * blob so the store package stays free of `@pnyx/portfolio` imports; only
 * the columns needed to sort / filter the list are projected out. Prices
 * (`usdValue`, change) are stored as last-known and treated as a prefill —
 * historical pricing will get its own tables.
 *
 * Adapters:
 *  - {@link ExpoSQLiteAssetsTable} – native (iOS / Android) via expo-sqlite
 *  - {@link IndexedDBAssetsTable}  – web / extension via IndexedDB
 *  - {@link MemoryAssetsTable}     – in-process for tests
 *
 * @module
 */

import {Context, type Effect} from 'effect'
import type {StoreErrors} from './errors.js'

/**
 * Schema version for the assets table.
 *
 * Bumped whenever the row shape, column set, or indexes change. On open,
 * adapters compare against the stored value and DROP+RECREATE on mismatch.
 * Portfolio fetch repopulates on next mount. Snapshots/checkpoints in the KV
 * store are untouched.
 */
export const ASSETS_TABLE_SCHEMA_VERSION = 1

/** Identity reference for a chain wallet's asset set. Mirrors `UtxoRef`. */
export type AssetRef = {
  readonly groupId: string
  readonly chainId: string
  readonly accountIndex: number
}

/**
 * A single row in the assets table.
 *
 * Composite primary key is `(groupId, chainId, accountIndex, id)` — the
 * natural identity of a held asset. `replaceAll` swaps the whole partition on
 * each portfolio fetch. `detailJson` is the serialized `ChainPortfolioAsset`
 * (opaque to the store); the projected columns back the list's sort/filter.
 */
export type AssetRow = AssetRef & {
  /** Asset id (e.g. `policyId.assetName`, `eip155:1/erc20:0x…`). */
  readonly id: string
  /** `TOKEN` | `NFT` | … — list filter. */
  readonly assetType: string
  /** Last-known USD value — default sort key (descending). */
  readonly usdValue: number
  /** Human-readable balance — the `> 0` filter the list applies. */
  readonly assetNumber: number
  /** Serialized full `ChainPortfolioAsset`. */
  readonly detailJson: string
}

/**
 * Query parameters for {@link AssetsTable.list}.
 *
 * Identity fields are required; results are returned sorted by `usdValue`
 * descending (the default holdings sort). `limit`/`offset` page the top
 * holdings; omit for the full set (needed for an exact portfolio total).
 */
export type AssetListQuery = AssetRef & {
  readonly limit?: number
  readonly offset?: number
}

/**
 * Assets table interface.
 *
 * Methods take an {@link AssetRef} so a single instance serves every
 * (group, chain, account) tuple — partitioned + indexed by those columns.
 *
 * Writes:
 *  - `replaceAll` atomically wipes the partition and inserts the new set —
 *    the natural shape for a full portfolio re-fetch.
 *  - `clear` wipes the partition without re-inserting (network switch,
 *    account delete).
 *
 * Reads:
 *  - `list` returns rows for an `AssetRef`, sorted by `usdValue` desc,
 *    optionally paged.
 *  - `count` returns the partition row count without materializing rows.
 *
 * Lifecycle:
 *  - `close` releases the underlying database/connection.
 */
export type AssetsTable = {
  readonly replaceAll: (ref: AssetRef, rows: ReadonlyArray<AssetRow>) => Effect.Effect<void, StoreErrors>
  readonly list: (query: AssetListQuery) => Effect.Effect<ReadonlyArray<AssetRow>, StoreErrors>
  readonly count: (ref: AssetRef) => Effect.Effect<number, StoreErrors>
  readonly clear: (ref: AssetRef) => Effect.Effect<void, StoreErrors>
  readonly close: () => Effect.Effect<void, StoreErrors>
}

/** Effect Service tag for dependency injection. */
export class AssetsTableService extends Context.Tag('AssetsTableService')<AssetsTableService, AssetsTable>() {}
