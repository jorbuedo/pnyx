/**
 * expo-sqlite implementation of {@link UtxoTable} for React Native.
 *
 * Backed by a `utxos` table with composite PK + an `assets_count` column
 * indexed for the Plutus-collateral filter. The `assets` array lives in a
 * JSON column so the row stays flat in SQL while preserving chain-specific
 * bundle shape.
 *
 * Schema versioning: on open we read the stored version from a `_meta`
 * table and DROP+RECREATE on mismatch. Chain-sync repopulates on next
 * mount. No migration framework — see {@link UTXO_TABLE_SCHEMA_VERSION}.
 *
 * @module
 */

import {Effect, Ref} from 'effect'
import type * as SQLite from 'expo-sqlite'
import {StoreClosedError, StoreError, type StoreErrors} from './errors.js'
import {openResilientDb} from './expo-sqlite-resilient.native.js'
import {UTXO_TABLE_SCHEMA_VERSION, type UtxoAsset, type UtxoRow, type UtxoTable} from './utxo-table.js'

// ----------------------------------------------------------------------------
// Row mapping
// ----------------------------------------------------------------------------

type DbRow = {
  group_id: string
  chain_id: string
  account_index: number
  tx_hash: string
  tx_index: number
  address: string
  quantity: string
  assets_count: number
  assets_json: string
}

const parseAssets = (json: string): ReadonlyArray<UtxoAsset> => {
  if (json === '' || json === '[]') return []
  try {
    return JSON.parse(json) as ReadonlyArray<UtxoAsset>
  } catch (e: unknown) {
    // `console` per this package's convention — it carries no logger dependency. An empty list
    // means "this UTxO holds only ADA", so a corrupt row silently loses its tokens.
    console.warn(`[utxo-table] stored assets could not be parsed, reporting none: ${String(e)}`)
    return []
  }
}

const fromDbRow = (r: DbRow): UtxoRow => ({
  groupId: r.group_id,
  chainId: r.chain_id,
  accountIndex: r.account_index,
  txHash: r.tx_hash,
  txIndex: r.tx_index,
  address: r.address,
  quantity: r.quantity,
  assets: parseAssets(r.assets_json),
})

// ----------------------------------------------------------------------------
// Schema
// ----------------------------------------------------------------------------

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS utxos (
    group_id TEXT NOT NULL,
    chain_id TEXT NOT NULL,
    account_index INTEGER NOT NULL,
    tx_hash TEXT NOT NULL,
    tx_index INTEGER NOT NULL,
    address TEXT NOT NULL,
    quantity TEXT NOT NULL,
    assets_count INTEGER NOT NULL DEFAULT 0,
    assets_json TEXT NOT NULL DEFAULT '[]',
    PRIMARY KEY (group_id, chain_id, account_index, tx_hash, tx_index)
  );

  CREATE INDEX IF NOT EXISTS idx_utxo_partition
    ON utxos (group_id, chain_id, account_index);

  CREATE INDEX IF NOT EXISTS idx_utxo_assets_count
    ON utxos (group_id, chain_id, account_index, assets_count);

  CREATE TABLE IF NOT EXISTS _meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`

const UTXO_TABLE_VERSION_KEY = 'utxo_table_version'

const DROP_SQL = `
  DROP INDEX IF EXISTS idx_utxo_assets_count;
  DROP INDEX IF EXISTS idx_utxo_partition;
  DROP TABLE IF EXISTS utxos;
`

// ----------------------------------------------------------------------------
// Factory
// ----------------------------------------------------------------------------

/**
 * Open the UTXOs table on the given expo-sqlite database.
 *
 * Defaults to `pnyx-utxo.db` — a dedicated file rather than sharing the
 * KV store's `pnyx.db`. Reasons mirror the transactions table:
 *  - schema bumps drop the table cleanly without touching KV snapshots
 *  - the table's write semaphore doesn't contend with the KV store's
 */
export const ExpoSQLiteUtxoTable = (dbName = 'pnyx-utxo.db'): Effect.Effect<UtxoTable, StoreError> =>
  Effect.gen(function* () {
    // `initSchema` must be idempotent: it runs on initial open AND on every
    // automatic reopen (after Android destroys our Activity and invalidates
    // the cached handle). All statements use CREATE … IF NOT EXISTS.
    const handle = yield* Effect.tryPromise({
      try: () => openResilientDb(dbName, (db) => db.execAsync(SCHEMA_SQL)),
      catch: (e) => new StoreError({message: `Failed to open utxo-table database: ${e}`, cause: e}),
    })

    const storedVersion = yield* Effect.tryPromise({
      try: () =>
        handle.with((db) =>
          db.getFirstAsync<{value: string}>('SELECT value FROM _meta WHERE key = ?', [UTXO_TABLE_VERSION_KEY]),
        ),
      catch: (e) => new StoreError({message: `Failed to read utxo-table version: ${e}`, cause: e}),
    })

    const storedVersionNum = storedVersion ? Number.parseInt(storedVersion.value, 10) : null
    if (storedVersionNum !== UTXO_TABLE_SCHEMA_VERSION) {
      yield* Effect.tryPromise({
        try: () => handle.with((db) => db.execAsync(DROP_SQL)),
        catch: (e) => new StoreError({message: `Failed to drop utxo-table on version mismatch: ${e}`, cause: e}),
      })
      yield* Effect.tryPromise({
        try: () => handle.with((db) => db.execAsync(SCHEMA_SQL)),
        catch: (e) => new StoreError({message: `Failed to recreate utxo-table schema: ${e}`, cause: e}),
      })
      yield* Effect.tryPromise({
        try: () =>
          handle.with((db) =>
            db.runAsync('INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)', [
              UTXO_TABLE_VERSION_KEY,
              String(UTXO_TABLE_SCHEMA_VERSION),
            ]),
          ),
        catch: (e) => new StoreError({message: `Failed to write utxo-table version: ${e}`, cause: e}),
      })
    }

    const closedRef = yield* Ref.make(false)
    const writeSemaphore = yield* Effect.makeSemaphore(1)

    const checkClosed: Effect.Effect<void, StoreErrors> = Effect.gen(function* () {
      if (yield* Ref.get(closedRef)) {
        return yield* Effect.fail(new StoreClosedError({message: 'UtxoTable is closed'}))
      }
    })

    const PUT_SQL = `
      INSERT OR REPLACE INTO utxos
        (group_id, chain_id, account_index, tx_hash, tx_index, address, quantity, assets_count, assets_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `

    const putParams = (row: UtxoRow) =>
      [
        row.groupId,
        row.chainId,
        row.accountIndex,
        row.txHash,
        row.txIndex,
        row.address,
        row.quantity,
        row.assets.length,
        row.assets.length === 0 ? '[]' : JSON.stringify(row.assets),
      ] as const

    const put: UtxoTable['put'] = (row) =>
      writeSemaphore.withPermits(1)(
        Effect.gen(function* () {
          yield* checkClosed
          yield* Effect.tryPromise({
            try: () => handle.with((db) => db.runAsync(PUT_SQL, putParams(row) as unknown as SQLite.SQLiteBindParams)),
            catch: (e) => new StoreError({message: `Failed to put utxo row: ${e}`, cause: e}),
          })
        }),
      )

    const putMany: UtxoTable['putMany'] = (rows) =>
      writeSemaphore.withPermits(1)(
        Effect.gen(function* () {
          yield* checkClosed
          if (rows.length === 0) return
          yield* Effect.tryPromise({
            try: () =>
              handle.with((db) =>
                db.withTransactionAsync(async () => {
                  for (const row of rows) {
                    await db.runAsync(PUT_SQL, putParams(row) as unknown as SQLite.SQLiteBindParams)
                  }
                }),
              ),
            catch: (e) => new StoreError({message: `Failed to put utxo rows: ${e}`, cause: e}),
          })
        }),
      )

    const deleteRows: UtxoTable['delete'] = (ref, keys) =>
      writeSemaphore.withPermits(1)(
        Effect.gen(function* () {
          yield* checkClosed
          if (keys.length === 0) return
          yield* Effect.tryPromise({
            try: () =>
              handle.with((db) =>
                db.withTransactionAsync(async () => {
                  for (const k of keys) {
                    await db.runAsync(
                      'DELETE FROM utxos WHERE group_id = ? AND chain_id = ? AND account_index = ? AND tx_hash = ? AND tx_index = ?',
                      [ref.groupId, ref.chainId, ref.accountIndex, k.txHash, k.txIndex],
                    )
                  }
                }),
              ),
            catch: (e) => new StoreError({message: `Failed to delete utxo rows: ${e}`, cause: e}),
          })
        }),
      )

    const replaceAll: UtxoTable['replaceAll'] = (ref, rows) =>
      writeSemaphore.withPermits(1)(
        Effect.gen(function* () {
          yield* checkClosed
          // Atomic clear + insert. Sync paths rely on this — partial state
          // would leave the wallet showing UTXOs from two different syncs.
          yield* Effect.tryPromise({
            try: () =>
              handle.with((db) =>
                db.withTransactionAsync(async () => {
                  await db.runAsync('DELETE FROM utxos WHERE group_id = ? AND chain_id = ? AND account_index = ?', [
                    ref.groupId,
                    ref.chainId,
                    ref.accountIndex,
                  ])
                  for (const row of rows) {
                    await db.runAsync(PUT_SQL, putParams(row) as unknown as SQLite.SQLiteBindParams)
                  }
                }),
              ),
            catch: (e) => new StoreError({message: `Failed to replace utxo rows: ${e}`, cause: e}),
          })
        }),
      )

    const list: UtxoTable['list'] = (q) =>
      Effect.gen(function* () {
        yield* checkClosed
        const where: string[] = ['group_id = ?', 'chain_id = ?', 'account_index = ?']
        const params: (string | number)[] = [q.groupId, q.chainId, q.accountIndex]
        if (q.pureOnly === true) {
          where.push('assets_count = 0')
        }
        const sql = `SELECT * FROM utxos WHERE ${where.join(' AND ')}`
        const rows = yield* Effect.tryPromise({
          try: () => handle.with((db) => db.getAllAsync<DbRow>(sql, params as SQLite.SQLiteBindParams)),
          catch: (e) => new StoreError({message: `Failed to list utxo rows: ${e}`, cause: e}),
        })
        return rows.map(fromDbRow)
      })

    const count: UtxoTable['count'] = (ref) =>
      Effect.gen(function* () {
        yield* checkClosed
        const row = yield* Effect.tryPromise({
          try: () =>
            handle.with((db) =>
              db.getFirstAsync<{n: number}>(
                'SELECT COUNT(*) AS n FROM utxos WHERE group_id = ? AND chain_id = ? AND account_index = ?',
                [ref.groupId, ref.chainId, ref.accountIndex],
              ),
            ),
          catch: (e) => new StoreError({message: `Failed to count utxo rows: ${e}`, cause: e}),
        })
        return row?.n ?? 0
      })

    const clear: UtxoTable['clear'] = (ref) =>
      writeSemaphore.withPermits(1)(
        Effect.gen(function* () {
          yield* checkClosed
          yield* Effect.tryPromise({
            try: () =>
              handle.with((db) =>
                db.runAsync('DELETE FROM utxos WHERE group_id = ? AND chain_id = ? AND account_index = ?', [
                  ref.groupId,
                  ref.chainId,
                  ref.accountIndex,
                ]),
              ),
            catch: (e) => new StoreError({message: `Failed to clear utxo rows: ${e}`, cause: e}),
          })
        }),
      )

    const close: UtxoTable['close'] = () =>
      Effect.gen(function* () {
        const wasClosed = yield* Ref.get(closedRef)
        if (wasClosed) return
        yield* Ref.set(closedRef, true)
        yield* Effect.tryPromise({
          try: () => handle.close(),
          catch: (e) => new StoreError({message: `Failed to close utxo-table database: ${e}`, cause: e}),
        })
      })

    const table: UtxoTable = {put, putMany, delete: deleteRows, replaceAll, list, count, clear, close}
    return table
  })
