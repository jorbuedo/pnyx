/**
 * expo-sqlite implementation of {@link AddressTable} for React Native.
 *
 * Backed by an `addresses` table with composite PK on
 * `(group_id, chain_id, account_index, branch, idx)` and two secondary
 * indexes:
 *  - `(chain_id, is_used)` — drives the cross-wallet airdrop scan.
 *  - `(group_id, chain_id, account_index, branch, is_used)` — drives
 *    per-wallet `getUsedAddresses` / `getUnusedAddresses`.
 *
 * Schema versioning: on open we read the stored version from a `_meta`
 * table and DROP+RECREATE on mismatch. Chain-sync repopulates on next
 * mount. No migration framework — see {@link ADDRESS_TABLE_SCHEMA_VERSION}.
 *
 * @module
 */

import {Effect, Ref} from 'effect'
import type * as SQLite from 'expo-sqlite'
import {
  ADDRESS_TABLE_SCHEMA_VERSION,
  type AddressBranch,
  type AddressListQuery,
  type AddressRow,
  type AddressTable,
} from './address-table.js'
import {StoreClosedError, StoreError, type StoreErrors} from './errors.js'
import {openResilientDb} from './expo-sqlite-resilient.native.js'

// ----------------------------------------------------------------------------
// Row mapping
// ----------------------------------------------------------------------------

type DbRow = {
  group_id: string
  chain_id: string
  account_index: number
  branch: string
  idx: number
  human: string
  hash: string
  is_used: number
}

const fromDbRow = (r: DbRow): AddressRow => ({
  groupId: r.group_id,
  chainId: r.chain_id,
  accountIndex: r.account_index,
  branch: r.branch as AddressBranch,
  index: r.idx,
  human: r.human,
  hash: r.hash,
  isUsed: r.is_used === 1,
})

// ----------------------------------------------------------------------------
// Schema
// ----------------------------------------------------------------------------

// `index` is reserved-adjacent in some SQL dialects and shadows the SQLite
// rowid alias intuition — column is named `idx` and mapped to/from
// `AddressRow.index` at the boundary.
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS addresses (
    group_id TEXT NOT NULL,
    chain_id TEXT NOT NULL,
    account_index INTEGER NOT NULL,
    branch TEXT NOT NULL,
    idx INTEGER NOT NULL,
    human TEXT NOT NULL,
    hash TEXT NOT NULL,
    is_used INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (group_id, chain_id, account_index, branch, idx)
  );

  CREATE INDEX IF NOT EXISTS idx_addr_chain_used
    ON addresses (chain_id, is_used);

  CREATE INDEX IF NOT EXISTS idx_addr_partition_branch_used
    ON addresses (group_id, chain_id, account_index, branch, is_used);

  CREATE TABLE IF NOT EXISTS _meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`

const ADDRESS_TABLE_VERSION_KEY = 'address_table_version'

const DROP_SQL = `
  DROP INDEX IF EXISTS idx_addr_partition_branch_used;
  DROP INDEX IF EXISTS idx_addr_chain_used;
  DROP TABLE IF EXISTS addresses;
`

// ----------------------------------------------------------------------------
// Factory
// ----------------------------------------------------------------------------

/**
 * Open the addresses table on the given expo-sqlite database.
 *
 * Defaults to `pnyx-address.db` — a dedicated file rather than sharing
 * the KV store's `pnyx.db`, mirroring the tx/utxo table pattern:
 *  - schema bumps drop the table cleanly without touching KV snapshots
 *  - the table's write semaphore doesn't contend with the KV store's
 */
export const ExpoSQLiteAddressTable = (dbName = 'pnyx-address.db'): Effect.Effect<AddressTable, StoreError> =>
  Effect.gen(function* () {
    // `initSchema` must be idempotent: it runs on initial open AND on every
    // automatic reopen (after Android destroys our Activity and invalidates
    // the cached handle). All statements use CREATE … IF NOT EXISTS.
    const handle = yield* Effect.tryPromise({
      try: () => openResilientDb(dbName, (db) => db.execAsync(SCHEMA_SQL)),
      catch: (e) => new StoreError({message: `Failed to open address-table database: ${e}`, cause: e}),
    })

    const storedVersion = yield* Effect.tryPromise({
      try: () =>
        handle.with((db) =>
          db.getFirstAsync<{value: string}>('SELECT value FROM _meta WHERE key = ?', [ADDRESS_TABLE_VERSION_KEY]),
        ),
      catch: (e) => new StoreError({message: `Failed to read address-table version: ${e}`, cause: e}),
    })

    const storedVersionNum = storedVersion ? Number.parseInt(storedVersion.value, 10) : null
    if (storedVersionNum !== ADDRESS_TABLE_SCHEMA_VERSION) {
      yield* Effect.tryPromise({
        try: () => handle.with((db) => db.execAsync(DROP_SQL)),
        catch: (e) => new StoreError({message: `Failed to drop address-table on version mismatch: ${e}`, cause: e}),
      })
      yield* Effect.tryPromise({
        try: () => handle.with((db) => db.execAsync(SCHEMA_SQL)),
        catch: (e) => new StoreError({message: `Failed to recreate address-table schema: ${e}`, cause: e}),
      })
      yield* Effect.tryPromise({
        try: () =>
          handle.with((db) =>
            db.runAsync('INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)', [
              ADDRESS_TABLE_VERSION_KEY,
              String(ADDRESS_TABLE_SCHEMA_VERSION),
            ]),
          ),
        catch: (e) => new StoreError({message: `Failed to write address-table version: ${e}`, cause: e}),
      })
    }

    const closedRef = yield* Ref.make(false)
    const writeSemaphore = yield* Effect.makeSemaphore(1)

    const checkClosed: Effect.Effect<void, StoreErrors> = Effect.gen(function* () {
      if (yield* Ref.get(closedRef)) {
        return yield* Effect.fail(new StoreClosedError({message: 'AddressTable is closed'}))
      }
    })

    const PUT_SQL = `
      INSERT OR REPLACE INTO addresses
        (group_id, chain_id, account_index, branch, idx, human, hash, is_used)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `

    const putParams = (row: AddressRow) =>
      [
        row.groupId,
        row.chainId,
        row.accountIndex,
        row.branch,
        row.index,
        row.human,
        row.hash,
        row.isUsed ? 1 : 0,
      ] as const

    const upsert: AddressTable['upsert'] = (row) =>
      writeSemaphore.withPermits(1)(
        Effect.gen(function* () {
          yield* checkClosed
          yield* Effect.tryPromise({
            try: () => handle.with((db) => db.runAsync(PUT_SQL, putParams(row) as unknown as SQLite.SQLiteBindParams)),
            catch: (e) => new StoreError({message: `Failed to upsert address row: ${e}`, cause: e}),
          })
        }),
      )

    const upsertMany: AddressTable['upsertMany'] = (rows) =>
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
            catch: (e) => new StoreError({message: `Failed to upsert address rows: ${e}`, cause: e}),
          })
        }),
      )

    const buildWhere = (q: AddressListQuery): {sql: string; params: (string | number)[]} => {
      const where: string[] = []
      const params: (string | number)[] = []
      if (q.groupId !== undefined) {
        where.push('group_id = ?')
        params.push(q.groupId)
      }
      if (q.chainId !== undefined) {
        where.push('chain_id = ?')
        params.push(q.chainId)
      }
      if (q.accountIndex !== undefined) {
        where.push('account_index = ?')
        params.push(q.accountIndex)
      }
      if (q.branch !== undefined) {
        where.push('branch = ?')
        params.push(q.branch)
      }
      if (q.isUsed !== undefined) {
        where.push('is_used = ?')
        params.push(q.isUsed ? 1 : 0)
      }
      return {sql: where.length === 0 ? '' : ` WHERE ${where.join(' AND ')}`, params}
    }

    const list: AddressTable['list'] = (q) =>
      Effect.gen(function* () {
        yield* checkClosed
        const {sql: whereSql, params} = buildWhere(q)
        const sql = `SELECT * FROM addresses${whereSql} ORDER BY group_id, chain_id, account_index, branch, idx`
        const rows = yield* Effect.tryPromise({
          try: () => handle.with((db) => db.getAllAsync<DbRow>(sql, params as SQLite.SQLiteBindParams)),
          catch: (e) => new StoreError({message: `Failed to list address rows: ${e}`, cause: e}),
        })
        return rows.map(fromDbRow)
      })

    const get: AddressTable['get'] = (ref, branch, index) =>
      Effect.gen(function* () {
        yield* checkClosed
        const row = yield* Effect.tryPromise({
          try: () =>
            handle.with((db) =>
              db.getFirstAsync<DbRow>(
                'SELECT * FROM addresses WHERE group_id = ? AND chain_id = ? AND account_index = ? AND branch = ? AND idx = ?',
                [ref.groupId, ref.chainId, ref.accountIndex, branch, index],
              ),
            ),
          catch: (e) => new StoreError({message: `Failed to get address row: ${e}`, cause: e}),
        })
        return row ? fromDbRow(row) : null
      })

    const count: AddressTable['count'] = (q) =>
      Effect.gen(function* () {
        yield* checkClosed
        const {sql: whereSql, params} = buildWhere(q)
        const sql = `SELECT COUNT(*) AS n FROM addresses${whereSql}`
        const row = yield* Effect.tryPromise({
          try: () => handle.with((db) => db.getFirstAsync<{n: number}>(sql, params as SQLite.SQLiteBindParams)),
          catch: (e) => new StoreError({message: `Failed to count address rows: ${e}`, cause: e}),
        })
        return row?.n ?? 0
      })

    const clear: AddressTable['clear'] = (ref) =>
      writeSemaphore.withPermits(1)(
        Effect.gen(function* () {
          yield* checkClosed
          yield* Effect.tryPromise({
            try: () =>
              handle.with((db) =>
                db.runAsync('DELETE FROM addresses WHERE group_id = ? AND chain_id = ? AND account_index = ?', [
                  ref.groupId,
                  ref.chainId,
                  ref.accountIndex,
                ]),
              ),
            catch: (e) => new StoreError({message: `Failed to clear address rows: ${e}`, cause: e}),
          })
        }),
      )

    const close: AddressTable['close'] = () =>
      Effect.gen(function* () {
        const wasClosed = yield* Ref.get(closedRef)
        if (wasClosed) return
        yield* Ref.set(closedRef, true)
        yield* Effect.tryPromise({
          try: () => handle.close(),
          catch: (e) => new StoreError({message: `Failed to close address-table database: ${e}`, cause: e}),
        })
      })

    const table: AddressTable = {upsert, upsertMany, list, get, count, clear, close}
    return table
  })
