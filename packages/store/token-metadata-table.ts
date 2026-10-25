/**
 * Token-metadata cache table — a GLOBAL, wallet-independent store of per-token
 * metadata (decimals, name, ticker, logo) keyed by `(network, tokenId)`.
 *
 * Unlike the tx / utxo / assets tables (partitioned per wallet), token metadata
 * is a property of the *token*, not the holder — the same token held by ten
 * wallets has one metadata entry. Keying it globally means it's fetched once
 * and reused across every wallet, account, and re-sync.
 *
 * Why it exists: a whale's portfolio enrichment (`cardanoApi.getBalances`)
 * re-fetched metadata for all ~15k tokens on every refresh (~305 requests of
 * the ~915-request, ~150s fetch) even though metadata barely changes. Caching
 * it means a refresh fetches metadata only for tokens not already cached.
 *
 * The metadata payload rides in an opaque `detailJson` blob so the store stays
 * free of `@pnyx/portfolio` imports; `fetchedAt` lets the consumer apply a
 * staleness TTL.
 *
 * Adapters:
 *  - {@link ExpoSQLiteTokenMetadataTable} – native (iOS / Android)
 *  - {@link IndexedDBTokenMetadataTable}  – web / extension
 *  - {@link MemoryTokenMetadataTable}     – in-process for tests
 *
 * @module
 */

import {Context, type Effect} from 'effect'
import type {StoreErrors} from './errors.js'

/** Bumped when the row shape / columns / indexes change → DROP+RECREATE on open. */
export const TOKEN_METADATA_TABLE_SCHEMA_VERSION = 1

/**
 * One cached token's metadata. Global identity is `(network, tokenId)` — no
 * wallet/account partition. `detailJson` is the serialized metadata payload.
 */
export type TokenMetadataRow = {
  /** `mainnet` | `testnet` — metadata can differ per network. */
  readonly network: string
  /** Token identity (`policyId.assetNameHex` for Cardano native tokens). */
  readonly tokenId: string
  /** Serialized metadata (opaque to the store). */
  readonly detailJson: string
  /** Unix ms when fetched — the consumer applies its own staleness TTL. */
  readonly fetchedAt: number
}

/**
 * Token-metadata table interface.
 *
 * Writes:
 *  - `putMany` upserts rows by `(network, tokenId)`.
 *
 * Reads:
 *  - `getMany` returns the cached rows for the given `(network, tokenIds)` —
 *    the caller diffs against its requested set to find cache misses.
 *
 * Lifecycle: `clear` wipes a network's rows; `close` releases the connection.
 */
export type TokenMetadataTable = {
  readonly putMany: (rows: ReadonlyArray<TokenMetadataRow>) => Effect.Effect<void, StoreErrors>
  readonly getMany: (
    network: string,
    tokenIds: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<TokenMetadataRow>, StoreErrors>
  readonly clear: (network: string) => Effect.Effect<void, StoreErrors>
  readonly close: () => Effect.Effect<void, StoreErrors>
}

/** Effect Service tag for dependency injection. */
export class TokenMetadataTableService extends Context.Tag('TokenMetadataTableService')<
  TokenMetadataTableService,
  TokenMetadataTable
>() {}
