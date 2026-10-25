/**
 * expo-sqlite implementation of {@link TokenPricesTable} for React Native.
 *
 * Single `token_prices` table keyed by `(network, cache_key)` — global, no
 * wallet partition. `getMany` chunks its `IN (...)` lookup to stay under
 * SQLite's bound-variable limit when a whale asks for many units.
 *
 * @module
 */

import {Effect, Ref} from 'effect'
import type * as SQLite from 'expo-sqlite'
import {StoreClosedError, StoreError, type StoreErrors} from './errors.js'
import {openResilientDb} from './expo-sqlite-resilient.native.js'
import {TOKEN_PRICES_TABLE_SCHEMA_VERSION, type TokenPriceRow, type TokenPricesTable} from './token-prices-table.js'

/** Chunk size for `IN (...)` lookups — well under SQLite's default 999 var cap. */
const GET_CHUNK = 400

type DbRow = {network: string; cache_key: string; value: number; fetched_at: number}

const fromDbRow = (r: DbRow): TokenPriceRow => ({
  network: r.network,
  cacheKey: r.cache_key,
  value: r.value,
  fetchedAt: r.fetched_at,
})

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS token_prices (
    network TEXT NOT NULL,
    cache_key TEXT NOT NULL,
    value REAL NOT NULL,
    fetched_at INTEGER NOT NULL,
    PRIMARY KEY (network, cache_key)
  );

  CREATE TABLE IF NOT EXISTS _meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`

const VERSION_KEY = 'token_prices_table_version'
const DROP_SQL = 'DROP TABLE IF EXISTS token_prices;'

export const ExpoSQLiteTokenPricesTable = (
  dbName = 'pnyx-token-prices.db',
): Effect.Effect<TokenPricesTable, StoreError> =>
  Effect.gen(function* () {
    const handle = yield* Effect.tryPromise({
      try: () => openResilientDb(dbName, (db) => db.execAsync(SCHEMA_SQL)),
      catch: (e) => new StoreError({message: `Failed to open token-prices database: ${e}`, cause: e}),
    })

    const storedVersion = yield* Effect.tryPromise({
      try: () =>
        handle.with((db) => db.getFirstAsync<{value: string}>('SELECT value FROM _meta WHERE key = ?', [VERSION_KEY])),
      catch: (e) => new StoreError({message: `Failed to read token-prices version: ${e}`, cause: e}),
    })

    const storedVersionNum = storedVersion ? Number.parseInt(storedVersion.value, 10) : null
    if (storedVersionNum !== TOKEN_PRICES_TABLE_SCHEMA_VERSION) {
      yield* Effect.tryPromise({
        try: () => handle.with((db) => db.execAsync(DROP_SQL)),
        catch: (e) => new StoreError({message: `Failed to drop token-prices on version mismatch: ${e}`, cause: e}),
      })
      yield* Effect.tryPromise({
        try: () => handle.with((db) => db.execAsync(SCHEMA_SQL)),
        catch: (e) => new StoreError({message: `Failed to recreate token-prices schema: ${e}`, cause: e}),
      })
      yield* Effect.tryPromise({
        try: () =>
          handle.with((db) =>
            db.runAsync('INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)', [
              VERSION_KEY,
              String(TOKEN_PRICES_TABLE_SCHEMA_VERSION),
            ]),
          ),
        catch: (e) => new StoreError({message: `Failed to write token-prices version: ${e}`, cause: e}),
      })
    }

    const closedRef = yield* Ref.make(false)
    const writeSemaphore = yield* Effect.makeSemaphore(1)

    const checkClosed: Effect.Effect<void, StoreErrors> = Effect.gen(function* () {
      if (yield* Ref.get(closedRef)) {
        return yield* Effect.fail(new StoreClosedError({message: 'TokenPricesTable is closed'}))
      }
    })

    const PUT_SQL = 'INSERT OR REPLACE INTO token_prices (network, cache_key, value, fetched_at) VALUES (?, ?, ?, ?)'

    const putMany: TokenPricesTable['putMany'] = (rows) =>
      writeSemaphore.withPermits(1)(
        Effect.gen(function* () {
          yield* checkClosed
          if (rows.length === 0) return
          yield* Effect.tryPromise({
            try: () =>
              handle.with((db) =>
                db.withTransactionAsync(async () => {
                  for (const r of rows) {
                    await db.runAsync(PUT_SQL, [r.network, r.cacheKey, r.value, r.fetchedAt])
                  }
                }),
              ),
            catch: (e) => new StoreError({message: `Failed to put token-prices rows: ${e}`, cause: e}),
          })
        }),
      )

    const getMany: TokenPricesTable['getMany'] = (network, cacheKeys) =>
      Effect.gen(function* () {
        yield* checkClosed
        if (cacheKeys.length === 0) return []
        const out: TokenPriceRow[] = []
        for (let i = 0; i < cacheKeys.length; i += GET_CHUNK) {
          const chunk = cacheKeys.slice(i, i + GET_CHUNK)
          const placeholders = chunk.map(() => '?').join(',')
          const sql = `SELECT * FROM token_prices WHERE network = ? AND cache_key IN (${placeholders})`
          const rows = yield* Effect.tryPromise({
            try: () => handle.with((db) => db.getAllAsync<DbRow>(sql, [network, ...chunk] as SQLite.SQLiteBindParams)),
            catch: (e) => new StoreError({message: `Failed to get token-prices rows: ${e}`, cause: e}),
          })
          for (const r of rows) out.push(fromDbRow(r))
        }
        return out
      })

    const clear: TokenPricesTable['clear'] = (network) =>
      writeSemaphore.withPermits(1)(
        Effect.gen(function* () {
          yield* checkClosed
          yield* Effect.tryPromise({
            try: () => handle.with((db) => db.runAsync('DELETE FROM token_prices WHERE network = ?', [network])),
            catch: (e) => new StoreError({message: `Failed to clear token-prices rows: ${e}`, cause: e}),
          })
        }),
      )

    const close: TokenPricesTable['close'] = () =>
      Effect.gen(function* () {
        const wasClosed = yield* Ref.get(closedRef)
        if (wasClosed) return
        yield* Ref.set(closedRef, true)
        yield* Effect.tryPromise({
          try: () => handle.close(),
          catch: (e) => new StoreError({message: `Failed to close token-prices database: ${e}`, cause: e}),
        })
      })

    const table: TokenPricesTable = {putMany, getMany, clear, close}
    return table
  })
