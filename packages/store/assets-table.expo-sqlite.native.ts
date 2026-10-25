/**
 * expo-sqlite implementation of {@link AssetsTable} for React Native.
 *
 * Backed by an `assets` table with composite PK and a `usd_value` index for
 * the default holdings sort. The full enriched asset lives in a `detail_json`
 * column so the row stays flat in SQL while the store stays free of
 * `@pnyx/portfolio` imports.
 *
 * Schema versioning: on open we read the stored version from a `_meta` table
 * and DROP+RECREATE on mismatch. Portfolio fetch repopulates on next mount.
 *
 * @module
 */

import {Effect, Ref} from 'effect'
import type * as SQLite from 'expo-sqlite'
import {ASSETS_TABLE_SCHEMA_VERSION, type AssetRow, type AssetsTable} from './assets-table.js'
import {StoreClosedError, StoreError, type StoreErrors} from './errors.js'
import {openResilientDb} from './expo-sqlite-resilient.native.js'

type DbRow = {
  group_id: string
  chain_id: string
  account_index: number
  id: string
  asset_type: string
  usd_value: number
  asset_number: number
  detail_json: string
}

const fromDbRow = (r: DbRow): AssetRow => ({
  groupId: r.group_id,
  chainId: r.chain_id,
  accountIndex: r.account_index,
  id: r.id,
  assetType: r.asset_type,
  usdValue: r.usd_value,
  assetNumber: r.asset_number,
  detailJson: r.detail_json,
})

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS assets (
    group_id TEXT NOT NULL,
    chain_id TEXT NOT NULL,
    account_index INTEGER NOT NULL,
    id TEXT NOT NULL,
    asset_type TEXT NOT NULL,
    usd_value REAL NOT NULL DEFAULT 0,
    asset_number REAL NOT NULL DEFAULT 0,
    detail_json TEXT NOT NULL,
    PRIMARY KEY (group_id, chain_id, account_index, id)
  );

  CREATE INDEX IF NOT EXISTS idx_assets_value
    ON assets (group_id, chain_id, account_index, usd_value);

  CREATE TABLE IF NOT EXISTS _meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`

const ASSETS_TABLE_VERSION_KEY = 'assets_table_version'

const DROP_SQL = `
  DROP INDEX IF EXISTS idx_assets_value;
  DROP TABLE IF EXISTS assets;
`

/**
 * Open the assets table on the given expo-sqlite database.
 *
 * Defaults to a dedicated `pnyx-assets.db` so schema bumps drop cleanly
 * without touching the KV snapshots and the write semaphore doesn't contend
 * with the KV store's — same rationale as the tx / utxo tables.
 */
export const ExpoSQLiteAssetsTable = (dbName = 'pnyx-assets.db'): Effect.Effect<AssetsTable, StoreError> =>
  Effect.gen(function* () {
    const handle = yield* Effect.tryPromise({
      try: () => openResilientDb(dbName, (db) => db.execAsync(SCHEMA_SQL)),
      catch: (e) => new StoreError({message: `Failed to open assets-table database: ${e}`, cause: e}),
    })

    const storedVersion = yield* Effect.tryPromise({
      try: () =>
        handle.with((db) =>
          db.getFirstAsync<{value: string}>('SELECT value FROM _meta WHERE key = ?', [ASSETS_TABLE_VERSION_KEY]),
        ),
      catch: (e) => new StoreError({message: `Failed to read assets-table version: ${e}`, cause: e}),
    })

    const storedVersionNum = storedVersion ? Number.parseInt(storedVersion.value, 10) : null
    if (storedVersionNum !== ASSETS_TABLE_SCHEMA_VERSION) {
      yield* Effect.tryPromise({
        try: () => handle.with((db) => db.execAsync(DROP_SQL)),
        catch: (e) => new StoreError({message: `Failed to drop assets-table on version mismatch: ${e}`, cause: e}),
      })
      yield* Effect.tryPromise({
        try: () => handle.with((db) => db.execAsync(SCHEMA_SQL)),
        catch: (e) => new StoreError({message: `Failed to recreate assets-table schema: ${e}`, cause: e}),
      })
      yield* Effect.tryPromise({
        try: () =>
          handle.with((db) =>
            db.runAsync('INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)', [
              ASSETS_TABLE_VERSION_KEY,
              String(ASSETS_TABLE_SCHEMA_VERSION),
            ]),
          ),
        catch: (e) => new StoreError({message: `Failed to write assets-table version: ${e}`, cause: e}),
      })
    }

    const closedRef = yield* Ref.make(false)
    const writeSemaphore = yield* Effect.makeSemaphore(1)

    const checkClosed: Effect.Effect<void, StoreErrors> = Effect.gen(function* () {
      if (yield* Ref.get(closedRef)) {
        return yield* Effect.fail(new StoreClosedError({message: 'AssetsTable is closed'}))
      }
    })

    const PUT_SQL = `
      INSERT OR REPLACE INTO assets
        (group_id, chain_id, account_index, id, asset_type, usd_value, asset_number, detail_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `

    const putParams = (row: AssetRow) =>
      [
        row.groupId,
        row.chainId,
        row.accountIndex,
        row.id,
        row.assetType,
        row.usdValue,
        row.assetNumber,
        row.detailJson,
      ] as const

    const replaceAll: AssetsTable['replaceAll'] = (ref, rows) =>
      writeSemaphore.withPermits(1)(
        Effect.gen(function* () {
          yield* checkClosed
          yield* Effect.tryPromise({
            try: () =>
              handle.with((db) =>
                db.withTransactionAsync(async () => {
                  await db.runAsync('DELETE FROM assets WHERE group_id = ? AND chain_id = ? AND account_index = ?', [
                    ref.groupId,
                    ref.chainId,
                    ref.accountIndex,
                  ])
                  for (const row of rows) {
                    await db.runAsync(PUT_SQL, putParams(row) as unknown as SQLite.SQLiteBindParams)
                  }
                }),
              ),
            catch: (e) => new StoreError({message: `Failed to replace asset rows: ${e}`, cause: e}),
          })
        }),
      )

    const list: AssetsTable['list'] = (q) =>
      Effect.gen(function* () {
        yield* checkClosed
        const params: (string | number)[] = [q.groupId, q.chainId, q.accountIndex]
        let sql =
          'SELECT * FROM assets WHERE group_id = ? AND chain_id = ? AND account_index = ? ORDER BY usd_value DESC'
        if (q.limit != null) {
          sql += ' LIMIT ? OFFSET ?'
          params.push(q.limit, q.offset ?? 0)
        }
        const rows = yield* Effect.tryPromise({
          try: () => handle.with((db) => db.getAllAsync<DbRow>(sql, params as SQLite.SQLiteBindParams)),
          catch: (e) => new StoreError({message: `Failed to list asset rows: ${e}`, cause: e}),
        })
        return rows.map(fromDbRow)
      })

    const count: AssetsTable['count'] = (ref) =>
      Effect.gen(function* () {
        yield* checkClosed
        const row = yield* Effect.tryPromise({
          try: () =>
            handle.with((db) =>
              db.getFirstAsync<{n: number}>(
                'SELECT COUNT(*) AS n FROM assets WHERE group_id = ? AND chain_id = ? AND account_index = ?',
                [ref.groupId, ref.chainId, ref.accountIndex],
              ),
            ),
          catch: (e) => new StoreError({message: `Failed to count asset rows: ${e}`, cause: e}),
        })
        return row?.n ?? 0
      })

    const clear: AssetsTable['clear'] = (ref) =>
      writeSemaphore.withPermits(1)(
        Effect.gen(function* () {
          yield* checkClosed
          yield* Effect.tryPromise({
            try: () =>
              handle.with((db) =>
                db.runAsync('DELETE FROM assets WHERE group_id = ? AND chain_id = ? AND account_index = ?', [
                  ref.groupId,
                  ref.chainId,
                  ref.accountIndex,
                ]),
              ),
            catch: (e) => new StoreError({message: `Failed to clear asset rows: ${e}`, cause: e}),
          })
        }),
      )

    const close: AssetsTable['close'] = () =>
      Effect.gen(function* () {
        const wasClosed = yield* Ref.get(closedRef)
        if (wasClosed) return
        yield* Ref.set(closedRef, true)
        yield* Effect.tryPromise({
          try: () => handle.close(),
          catch: (e) => new StoreError({message: `Failed to close assets-table database: ${e}`, cause: e}),
        })
      })

    const table: AssetsTable = {replaceAll, list, count, clear, close}
    return table
  })
