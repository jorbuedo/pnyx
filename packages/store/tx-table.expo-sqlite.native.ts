/**
 * expo-sqlite implementation of {@link TxTable} for React Native (iOS/Android).
 *
 * Backed by a `transactions` table with composite primary key + secondary
 * indexes on timestamp / status / type — gives the activity-list path
 * proper relational ordering, filtering, and projection without parsing
 * every row's blob in JS.
 *
 * Schema versioning: on open we read the stored version from a `_meta`
 * table and DROP the transactions table on mismatch. Chain-sync
 * re-populates on next mount. No migration framework — see
 * {@link TX_TABLE_SCHEMA_VERSION}.
 *
 * @module
 */

import {Effect, Ref} from 'effect'
import type * as SQLite from 'expo-sqlite'
import {StoreClosedError, StoreError, type StoreErrors} from './errors.js'
import {openResilientDb} from './expo-sqlite-resilient.native.js'
import {
  TX_TABLE_SCHEMA_VERSION,
  type TxListItem,
  type TxRef,
  type TxRow,
  type TxStatus,
  type TxTable,
  type TxType,
} from './tx-table.js'

// ----------------------------------------------------------------------------
// Row mapping
// ----------------------------------------------------------------------------

/** Snake_case → camelCase shape returned by `SELECT` */
type DbRow = {
  group_id: string
  chain_id: string
  account_index: number
  hash: string
  timestamp: number | null
  submitted_at: number | null
  status: string
  type: string
  direction: string
  amount: string
  fee: string | null
  counterparty_address: string | null
  primary_asset_delta: string | null
  additional_asset_count: number
  has_nft: number
  asset_symbol: string | null
  asset_decimals: number | null
  icon_url: string | null
  token_id: string | null
  contract_address: string | null
  list_meta_json: string | null
  detail_json: string
}

/** Same as `DbRow` minus the detail blob — what `SELECT … WITHOUT detail_json` returns. */
type DbListRow = Omit<DbRow, 'detail_json'>

const toListItem = (r: DbListRow): TxListItem => ({
  groupId: r.group_id,
  chainId: r.chain_id,
  accountIndex: r.account_index,
  hash: r.hash,
  timestamp: r.timestamp,
  submittedAt: r.submitted_at,
  status: r.status as TxStatus,
  type: r.type as TxType,
  direction: r.direction as TxRow['direction'],
  amount: r.amount,
  fee: r.fee,
  counterpartyAddress: r.counterparty_address,
  primaryAssetDelta: r.primary_asset_delta,
  additionalAssetCount: r.additional_asset_count,
  hasNft: r.has_nft === 1,
  assetSymbol: r.asset_symbol,
  assetDecimals: r.asset_decimals,
  iconUrl: r.icon_url,
  tokenId: r.token_id,
  contractAddress: r.contract_address,
  listMetaJson: r.list_meta_json,
})

const fromDbRow = (r: DbRow): TxRow => ({...toListItem(r), detailJson: r.detail_json})

const fromDbListRow = (r: DbListRow): TxListItem => toListItem(r)

// ----------------------------------------------------------------------------
// Schema
// ----------------------------------------------------------------------------

/**
 * Create the `transactions` table + indexes and the `_meta` table.
 *
 * `transactions` columns:
 *  - composite PK on (group_id, chain_id, account_index, hash) — natural
 *    upsert key and the iteration partition we always filter on.
 *  - timestamp is INTEGER NULL — pending rows without a known submit time
 *    sort to the top via `ORDER BY timestamp DESC NULLS FIRST`.
 *  - detail_json is TEXT NOT NULL — opaque chain-specific payload, never
 *    selected by the list path.
 *
 * `idx_tx_timestamp` is the workhorse — every list query filters on the
 * PK partition and orders by timestamp.
 */
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS transactions (
    group_id TEXT NOT NULL,
    chain_id TEXT NOT NULL,
    account_index INTEGER NOT NULL,
    hash TEXT NOT NULL,
    timestamp INTEGER,
    submitted_at INTEGER,
    status TEXT NOT NULL,
    type TEXT NOT NULL,
    direction TEXT NOT NULL,
    amount TEXT NOT NULL,
    fee TEXT,
    counterparty_address TEXT,
    primary_asset_delta TEXT,
    additional_asset_count INTEGER NOT NULL DEFAULT 0,
    has_nft INTEGER NOT NULL DEFAULT 0,
    asset_symbol TEXT,
    asset_decimals INTEGER,
    icon_url TEXT,
    token_id TEXT,
    contract_address TEXT,
    list_meta_json TEXT,
    detail_json TEXT NOT NULL,
    PRIMARY KEY (group_id, chain_id, account_index, hash)
  );

  CREATE INDEX IF NOT EXISTS idx_tx_timestamp
    ON transactions (group_id, chain_id, account_index, timestamp DESC);

  CREATE INDEX IF NOT EXISTS idx_tx_status
    ON transactions (group_id, chain_id, account_index, status);

  CREATE INDEX IF NOT EXISTS idx_tx_type
    ON transactions (group_id, chain_id, account_index, type);

  CREATE TABLE IF NOT EXISTS _meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`

const TX_TABLE_VERSION_KEY = 'tx_table_version'

/**
 * Drop the transactions table — used when the stored schema version
 * doesn't match {@link TX_TABLE_SCHEMA_VERSION}. The `_meta` table
 * itself is left alone (the version write happens immediately after).
 */
const DROP_SQL = `
  DROP INDEX IF EXISTS idx_tx_timestamp;
  DROP INDEX IF EXISTS idx_tx_status;
  DROP INDEX IF EXISTS idx_tx_type;
  DROP TABLE IF EXISTS transactions;
`

// ----------------------------------------------------------------------------
// Factory
// ----------------------------------------------------------------------------

/**
 * Open the transactions table on the given expo-sqlite database.
 *
 * Defaults to `pnyx-tx.db` — a dedicated file rather than sharing the
 * KV store's `pnyx.db`. Two reasons:
 *  - schema bumps drop a single table cleanly without touching the KV
 *    snapshots and checkpoints stored alongside,
 *  - the table's write semaphore doesn't contend with the KV store's
 *    write semaphore.
 *
 * `pnyx.db` consumers are unaffected.
 */
export const ExpoSQLiteTxTable = (dbName = 'pnyx-tx.db'): Effect.Effect<TxTable, StoreError> =>
  Effect.gen(function* () {
    // `initSchema` must be idempotent: it runs on initial open AND on every
    // automatic reopen (after Android destroys our Activity and invalidates
    // the cached handle). All statements use CREATE … IF NOT EXISTS.
    const handle = yield* Effect.tryPromise({
      try: () => openResilientDb(dbName, (db) => db.execAsync(SCHEMA_SQL)),
      catch: (e) => new StoreError({message: `Failed to open tx-table database: ${e}`, cause: e}),
    })

    // Check the stored schema version. Drop and recreate on mismatch —
    // chain-sync will re-populate on next mount. Runs once at open; reopens
    // never re-trigger this path because they only replay `initSchema`.
    const storedVersion = yield* Effect.tryPromise({
      try: () =>
        handle.with((db) =>
          db.getFirstAsync<{value: string}>('SELECT value FROM _meta WHERE key = ?', [TX_TABLE_VERSION_KEY]),
        ),
      catch: (e) => new StoreError({message: `Failed to read tx-table version: ${e}`, cause: e}),
    })

    const storedVersionNum = storedVersion ? Number.parseInt(storedVersion.value, 10) : null
    if (storedVersionNum !== TX_TABLE_SCHEMA_VERSION) {
      yield* Effect.tryPromise({
        try: () => handle.with((db) => db.execAsync(DROP_SQL)),
        catch: (e) => new StoreError({message: `Failed to drop tx-table on version mismatch: ${e}`, cause: e}),
      })
      yield* Effect.tryPromise({
        try: () => handle.with((db) => db.execAsync(SCHEMA_SQL)),
        catch: (e) => new StoreError({message: `Failed to recreate tx-table schema: ${e}`, cause: e}),
      })
      yield* Effect.tryPromise({
        try: () =>
          handle.with((db) =>
            db.runAsync('INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)', [
              TX_TABLE_VERSION_KEY,
              String(TX_TABLE_SCHEMA_VERSION),
            ]),
          ),
        catch: (e) => new StoreError({message: `Failed to write tx-table version: ${e}`, cause: e}),
      })
    }

    const closedRef = yield* Ref.make(false)

    // Serialize writes — concurrent putMany calls from parallel chain
    // syncs would otherwise step on each other's transactions.
    const writeSemaphore = yield* Effect.makeSemaphore(1)

    const checkClosed: Effect.Effect<void, StoreErrors> = Effect.gen(function* () {
      if (yield* Ref.get(closedRef)) {
        return yield* Effect.fail(new StoreClosedError({message: 'TxTable is closed'}))
      }
    })

    const PUT_SQL = `
      INSERT OR REPLACE INTO transactions
        (group_id, chain_id, account_index, hash, timestamp, submitted_at, status, type, direction, amount, fee,
         counterparty_address, primary_asset_delta, additional_asset_count, has_nft, asset_symbol, asset_decimals,
         icon_url, token_id, contract_address, list_meta_json, detail_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `

    const putParams = (row: TxRow) =>
      [
        row.groupId,
        row.chainId,
        row.accountIndex,
        row.hash,
        row.timestamp,
        row.submittedAt,
        row.status,
        row.type,
        row.direction,
        row.amount,
        row.fee,
        row.counterpartyAddress,
        row.primaryAssetDelta,
        row.additionalAssetCount,
        row.hasNft ? 1 : 0,
        row.assetSymbol,
        row.assetDecimals,
        row.iconUrl,
        row.tokenId,
        row.contractAddress,
        row.listMetaJson,
        row.detailJson,
      ] as const

    const put: TxTable['put'] = (row) =>
      writeSemaphore.withPermits(1)(
        Effect.gen(function* () {
          yield* checkClosed
          yield* Effect.tryPromise({
            try: () => handle.with((db) => db.runAsync(PUT_SQL, putParams(row) as unknown as SQLite.SQLiteBindParams)),
            catch: (e) => new StoreError({message: `Failed to put tx row: ${e}`, cause: e}),
          })
        }),
      )

    const putMany: TxTable['putMany'] = (rows) =>
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
            catch: (e) => new StoreError({message: `Failed to put tx rows: ${e}`, cause: e}),
          })
        }),
      )

    const LIST_COLUMNS =
      'group_id, chain_id, account_index, hash, timestamp, submitted_at, status, type, direction, amount, fee, ' +
      'counterparty_address, primary_asset_delta, additional_asset_count, has_nft, asset_symbol, asset_decimals, ' +
      'icon_url, token_id, contract_address, list_meta_json'

    const list: TxTable['list'] = (q) =>
      Effect.gen(function* () {
        yield* checkClosed
        const where: string[] = ['group_id = ?', 'chain_id = ?', 'account_index = ?']
        const params: (string | number)[] = [q.groupId, q.chainId, q.accountIndex]

        if (q.status !== undefined) {
          where.push('status = ?')
          params.push(q.status)
        }
        if (q.types !== undefined && q.types.length > 0) {
          where.push(`type IN (${q.types.map(() => '?').join(', ')})`)
          for (const t of q.types) params.push(t)
        }
        if (q.newerThan !== undefined) {
          where.push('timestamp IS NOT NULL AND timestamp > ?')
          params.push(q.newerThan)
        }
        if (q.olderThan !== undefined) {
          where.push('timestamp IS NOT NULL AND timestamp < ?')
          params.push(q.olderThan)
        }

        // ORDER BY timestamp DESC NULLS FIRST mirrors the documented
        // contract: pending rows without a submit time pin to the top.
        // SQLite supports NULLS FIRST since 3.30 (2019) — well below
        // expo-sqlite's minimum.
        const limitClause = q.limit !== undefined ? `LIMIT ${Math.max(0, Math.floor(q.limit))}` : ''
        const offsetClause = q.offset !== undefined ? `OFFSET ${Math.max(0, Math.floor(q.offset))}` : ''
        const sql = `
          SELECT ${LIST_COLUMNS}
          FROM transactions
          WHERE ${where.join(' AND ')}
          ORDER BY timestamp DESC NULLS FIRST
          ${limitClause}
          ${offsetClause}
        `

        const rows = yield* Effect.tryPromise({
          try: () => handle.with((db) => db.getAllAsync<DbListRow>(sql, params as SQLite.SQLiteBindParams)),
          catch: (e) => new StoreError({message: `Failed to list tx rows: ${e}`, cause: e}),
        })
        return rows.map(fromDbListRow)
      })

    const get: TxTable['get'] = (ref, hash) =>
      Effect.gen(function* () {
        yield* checkClosed
        const row = yield* Effect.tryPromise({
          try: () =>
            handle.with((db) =>
              db.getFirstAsync<DbRow>(
                'SELECT * FROM transactions WHERE group_id = ? AND chain_id = ? AND account_index = ? AND hash = ?',
                [ref.groupId, ref.chainId, ref.accountIndex, hash],
              ),
            ),
          catch: (e) => new StoreError({message: `Failed to get tx row: ${e}`, cause: e}),
        })
        return row ? fromDbRow(row) : null
      })

    const prune: TxTable['prune'] = (ref: TxRef, keepCount) =>
      writeSemaphore.withPermits(1)(
        Effect.gen(function* () {
          yield* checkClosed
          // Delete every row outside the top `keepCount` newest. Done in
          // a single DELETE using a correlated subquery so we never
          // materialize the full row set in JS.
          const result = yield* Effect.tryPromise({
            try: () =>
              handle.with((db) =>
                db.runAsync(
                  `DELETE FROM transactions
                   WHERE group_id = ? AND chain_id = ? AND account_index = ?
                     AND hash NOT IN (
                       SELECT hash FROM transactions
                       WHERE group_id = ? AND chain_id = ? AND account_index = ?
                       ORDER BY timestamp DESC NULLS FIRST
                       LIMIT ?
                     )`,
                  [
                    ref.groupId,
                    ref.chainId,
                    ref.accountIndex,
                    ref.groupId,
                    ref.chainId,
                    ref.accountIndex,
                    Math.max(0, Math.floor(keepCount)),
                  ],
                ),
              ),
            catch: (e) => new StoreError({message: `Failed to prune tx rows: ${e}`, cause: e}),
          })
          return result.changes
        }),
      )

    const clear: TxTable['clear'] = (ref) =>
      writeSemaphore.withPermits(1)(
        Effect.gen(function* () {
          yield* checkClosed
          yield* Effect.tryPromise({
            try: () =>
              handle.with((db) =>
                db.runAsync('DELETE FROM transactions WHERE group_id = ? AND chain_id = ? AND account_index = ?', [
                  ref.groupId,
                  ref.chainId,
                  ref.accountIndex,
                ]),
              ),
            catch: (e) => new StoreError({message: `Failed to clear tx rows: ${e}`, cause: e}),
          })
        }),
      )

    const close: TxTable['close'] = () =>
      Effect.gen(function* () {
        const wasClosed = yield* Ref.get(closedRef)
        if (wasClosed) return
        yield* Ref.set(closedRef, true)
        yield* Effect.tryPromise({
          try: () => handle.close(),
          catch: (e) => new StoreError({message: `Failed to close tx-table database: ${e}`, cause: e}),
        })
      })

    const table: TxTable = {put, putMany, list, get, prune, clear, close}
    return table
  })
