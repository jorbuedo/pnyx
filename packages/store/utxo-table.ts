/**
 * UTXOs table — list-shaped, indexed storage for the wallet's unspent outputs.
 *
 * Lifted out of `WalletSnapshot.utxos` so coin selection, collateral picks,
 * CIP-30 UTXO queries, signer payload assembly, and sync diffs don't pay a
 * full snapshot reparse per access. Mirrors the design of the transactions
 * table — same `Store` ↔ `Table` separation, same schema-versioning model.
 *
 * Adapters:
 *  - {@link ExpoSQLiteUtxoTable} – native (iOS / Android) via expo-sqlite
 *  - {@link IndexedDBUtxoTable}  – web / extension via IndexedDB
 *  - {@link MemoryUtxoTable}     – in-process for tests
 *
 * Unlike the transactions table there is no `detailJson` blob: the
 * `StoredUtxo` shape is small and every field is used at read time. The
 * `assets` array lives in a JSON column so the row stays flat in SQL
 * while preserving the chain-specific bundle shape.
 *
 * @module
 */

import {Context, type Effect} from 'effect'
import type {StoreErrors} from './errors.js'

/**
 * Schema version for the UTXOs table.
 *
 * Bumped whenever the row shape, column set, or indexes change. On open,
 * adapters compare against the stored value and DROP+RECREATE on mismatch.
 * Chain-sync repopulates on next mount. Snapshots/checkpoints in the KV
 * store are untouched.
 */
export const UTXO_TABLE_SCHEMA_VERSION = 1

/**
 * Identity reference for a chain wallet's UTXO set.
 *
 * Mirrors the `TxRef` shape from the transactions table. Duplicated here
 * so the store package can stay free of wallet-package imports.
 */
export type UtxoRef = {
  readonly groupId: string
  readonly chainId: string
  readonly accountIndex: number
}

/**
 * Asset bundle entry for a UTXO — native tokens (Cardano), token program
 * accounts (Solana SPL), etc.
 */
export type UtxoAsset = {
  readonly id: string
  readonly quantity: string
}

/**
 * A single row in the UTXOs table.
 *
 * Composite primary key is `(groupId, chainId, accountIndex, txHash, txIndex)`
 * — the natural identity of an unspent output. Upserts replace by this key.
 */
export type UtxoRow = UtxoRef & {
  readonly txHash: string
  readonly txIndex: number
  readonly address: string
  /** Primary-token amount as a decimal string (lovelace / sats / lamports / drops). */
  readonly quantity: string
  /** Native-token bundle. Empty for pure primary-token UTXOs — those are the only ones eligible for Plutus collateral. */
  readonly assets: ReadonlyArray<UtxoAsset>
}

/**
 * Query parameters for {@link UtxoTable.list}.
 *
 * Identity fields (`groupId`, `chainId`, `accountIndex`) are required; the
 * rest narrow the result.
 *
 * `pureOnly` returns only UTXOs with no native-token bundle — the typical
 * filter for Plutus collateral selection. Backed by a column index, not
 * a JS-side filter.
 */
export type UtxoListQuery = UtxoRef & {
  /** When `true`, return only UTXOs with empty `assets` (collateral candidates). */
  readonly pureOnly?: boolean
}

/**
 * UTXOs table interface.
 *
 * Methods take a {@link UtxoRef} (rather than a scoped sub-handle) so a
 * single table instance serves every (group, chain, account) tuple — the
 * underlying storage is partitioned by those columns + indexed.
 *
 * Writes:
 *  - `put` / `putMany` upsert by `(group, chain, account, txHash, txIndex)`.
 *  - `delete` removes a set of UTXOs by their `(txHash, txIndex)` pairs —
 *    the natural shape for "spent in this tx".
 *  - `replaceAll` atomically wipes the partition and inserts the new set —
 *    the natural shape for a full chain re-sync.
 *  - `clear` wipes the partition without re-inserting (network switch,
 *    account delete).
 *
 * Reads:
 *  - `list` returns rows for a `UtxoRef`, optionally narrowed by
 *    {@link UtxoListQuery.pureOnly}.
 *  - `count` returns the row count for the partition without materializing
 *    rows — used by sync analytics and snapshot summaries.
 *
 * Lifecycle:
 *  - `close` releases the underlying database/connection.
 */
export type UtxoTable = {
  readonly put: (row: UtxoRow) => Effect.Effect<void, StoreErrors>
  readonly putMany: (rows: ReadonlyArray<UtxoRow>) => Effect.Effect<void, StoreErrors>
  readonly delete: (
    ref: UtxoRef,
    keys: ReadonlyArray<{readonly txHash: string; readonly txIndex: number}>,
  ) => Effect.Effect<void, StoreErrors>
  readonly replaceAll: (ref: UtxoRef, rows: ReadonlyArray<UtxoRow>) => Effect.Effect<void, StoreErrors>
  readonly list: (query: UtxoListQuery) => Effect.Effect<ReadonlyArray<UtxoRow>, StoreErrors>
  readonly count: (ref: UtxoRef) => Effect.Effect<number, StoreErrors>
  readonly clear: (ref: UtxoRef) => Effect.Effect<void, StoreErrors>
  readonly close: () => Effect.Effect<void, StoreErrors>
}

/**
 * Effect Service tag for dependency injection.
 */
export class UtxoTableService extends Context.Tag('UtxoTableService')<UtxoTableService, UtxoTable>() {}
