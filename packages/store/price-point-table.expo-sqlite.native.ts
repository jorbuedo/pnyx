/**
 * expo-sqlite implementation of {@link PricePointTable} for React Native.
 *
 * Single `price_point` table keyed by `(network, series_key, ts_bucket)`.
 * `getRange` does an indexed range scan per series; `prune` deletes a series'
 * points older than a cutoff (monthly downsample/cleanup).
 *
 * @module
 */

import {Effect, Ref} from 'effect'
import type * as SQLite from 'expo-sqlite'
import {StoreClosedError, StoreError, type StoreErrors} from './errors.js'
import {openResilientDb} from './expo-sqlite-resilient.native.js'
import {PRICE_POINT_TABLE_SCHEMA_VERSION, type PricePointRow, type PricePointTable} from './price-point-table.js'

type DbRow = {network: string; series_key: string; ts_bucket: number; value: number; source: string}

const fromDbRow = (r: DbRow): PricePointRow => ({
  network: r.network,
  seriesKey: r.series_key,
  tsBucket: r.ts_bucket,
  value: r.value,
  source: r.source,
})

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS price_point (
    network TEXT NOT NULL,
    series_key TEXT NOT NULL,
    ts_bucket INTEGER NOT NULL,
    value REAL NOT NULL,
    source TEXT NOT NULL,
    PRIMARY KEY (network, series_key, ts_bucket)
  );

  CREATE TABLE IF NOT EXISTS _meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`

const VERSION_KEY = 'price_point_table_version'
const DROP_SQL = 'DROP TABLE IF EXISTS price_point;'

export const ExpoSQLitePricePointTable = (dbName = 'pnyx-price-point.db'): Effect.Effect<PricePointTable, StoreError> =>
  Effect.gen(function* () {
    const handle = yield* Effect.tryPromise({
      try: () => openResilientDb(dbName, (db) => db.execAsync(SCHEMA_SQL)),
      catch: (e) => new StoreError({message: `Failed to open price-point database: ${e}`, cause: e}),
    })

    const storedVersion = yield* Effect.tryPromise({
      try: () =>
        handle.with((db) => db.getFirstAsync<{value: string}>('SELECT value FROM _meta WHERE key = ?', [VERSION_KEY])),
      catch: (e) => new StoreError({message: `Failed to read price-point version: ${e}`, cause: e}),
    })

    const storedVersionNum = storedVersion ? Number.parseInt(storedVersion.value, 10) : null
    if (storedVersionNum !== PRICE_POINT_TABLE_SCHEMA_VERSION) {
      yield* Effect.tryPromise({
        try: () => handle.with((db) => db.execAsync(DROP_SQL)),
        catch: (e) => new StoreError({message: `Failed to drop price-point on version mismatch: ${e}`, cause: e}),
      })
      yield* Effect.tryPromise({
        try: () => handle.with((db) => db.execAsync(SCHEMA_SQL)),
        catch: (e) => new StoreError({message: `Failed to recreate price-point schema: ${e}`, cause: e}),
      })
      yield* Effect.tryPromise({
        try: () =>
          handle.with((db) =>
            db.runAsync('INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)', [
              VERSION_KEY,
              String(PRICE_POINT_TABLE_SCHEMA_VERSION),
            ]),
          ),
        catch: (e) => new StoreError({message: `Failed to write price-point version: ${e}`, cause: e}),
      })
    }

    const closedRef = yield* Ref.make(false)
    const writeSemaphore = yield* Effect.makeSemaphore(1)

    const checkClosed: Effect.Effect<void, StoreErrors> = Effect.gen(function* () {
      if (yield* Ref.get(closedRef)) {
        return yield* Effect.fail(new StoreClosedError({message: 'PricePointTable is closed'}))
      }
    })

    const PUT_SQL =
      'INSERT OR REPLACE INTO price_point (network, series_key, ts_bucket, value, source) VALUES (?, ?, ?, ?, ?)'

    const putMany: PricePointTable['putMany'] = (rows) =>
      writeSemaphore.withPermits(1)(
        Effect.gen(function* () {
          yield* checkClosed
          if (rows.length === 0) return
          yield* Effect.tryPromise({
            try: () =>
              handle.with((db) =>
                db.withTransactionAsync(async () => {
                  for (const r of rows) {
                    await db.runAsync(PUT_SQL, [r.network, r.seriesKey, r.tsBucket, r.value, r.source])
                  }
                }),
              ),
            catch: (e) => new StoreError({message: `Failed to put price-point rows: ${e}`, cause: e}),
          })
        }),
      )

    const getRange: PricePointTable['getRange'] = (network, seriesKey, fromTsBucket, toTsBucket) =>
      Effect.gen(function* () {
        yield* checkClosed
        const rows = yield* Effect.tryPromise({
          try: () =>
            handle.with((db) =>
              db.getAllAsync<DbRow>(
                'SELECT * FROM price_point WHERE network = ? AND series_key = ? AND ts_bucket >= ? AND ts_bucket <= ? ORDER BY ts_bucket ASC',
                [network, seriesKey, fromTsBucket, toTsBucket] as SQLite.SQLiteBindParams,
              ),
            ),
          catch: (e) => new StoreError({message: `Failed to get price-point range: ${e}`, cause: e}),
        })
        return rows.map(fromDbRow)
      })

    const prune: PricePointTable['prune'] = (network, seriesKey, beforeTsBucket) =>
      writeSemaphore.withPermits(1)(
        Effect.gen(function* () {
          yield* checkClosed
          yield* Effect.tryPromise({
            try: () =>
              handle.with((db) =>
                db.runAsync('DELETE FROM price_point WHERE network = ? AND series_key = ? AND ts_bucket < ?', [
                  network,
                  seriesKey,
                  beforeTsBucket,
                ]),
              ),
            catch: (e) => new StoreError({message: `Failed to prune price-point rows: ${e}`, cause: e}),
          })
        }),
      )

    const clear: PricePointTable['clear'] = (network) =>
      writeSemaphore.withPermits(1)(
        Effect.gen(function* () {
          yield* checkClosed
          yield* Effect.tryPromise({
            try: () => handle.with((db) => db.runAsync('DELETE FROM price_point WHERE network = ?', [network])),
            catch: (e) => new StoreError({message: `Failed to clear price-point rows: ${e}`, cause: e}),
          })
        }),
      )

    const close: PricePointTable['close'] = () =>
      Effect.gen(function* () {
        const wasClosed = yield* Ref.get(closedRef)
        if (wasClosed) return
        yield* Ref.set(closedRef, true)
        yield* Effect.tryPromise({
          try: () => handle.close(),
          catch: (e) => new StoreError({message: `Failed to close price-point database: ${e}`, cause: e}),
        })
      })

    const table: PricePointTable = {putMany, getRange, prune, clear, close}
    return table
  })
