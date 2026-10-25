/**
 * SQLite-based store for React Native using expo-sqlite.
 *
 * Provides unlimited storage with proper SQL schema for wallet data.
 * This is the React Native implementation with static imports.
 *
 * Every native call is routed through {@link openResilientDb} so the
 * cached handle is automatically reopened if Android destroys the
 * Activity under memory pressure and invalidates it mid-session.
 *
 * @module
 */

import {Effect, Ref, Stream} from 'effect'
import {KeyNotFoundError, StoreClosedError, StoreError, type StoreErrors} from './errors.js'
import {openResilientDb} from './expo-sqlite-resilient.native.js'
import {type BatchOp, createScopedStore, type Store, StoreService} from './store.js'

/**
 * Convert Uint8Array to hex string for SQL BLOB comparison.
 */
const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS kv_store (
    key BLOB PRIMARY KEY,
    value BLOB NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_kv_key_hex ON kv_store(hex(key));
`

/**
 * Create a SQLite-based store using expo-sqlite.
 *
 * @param dbName - Database file name (default: 'pnyx.db')
 */
export const ExpoSQLiteStore = (dbName = 'pnyx.db'): Effect.Effect<typeof StoreService.Service, StoreError> =>
  Effect.gen(function* () {
    const handle = yield* Effect.tryPromise({
      try: () => openResilientDb(dbName, (db) => db.execAsync(SCHEMA_SQL)),
      catch: (e) => new StoreError({message: `Failed to open database: ${e}`, cause: e}),
    })

    const closedRef = yield* Ref.make(false)

    // Serialize all write operations to prevent "cannot start a transaction within a transaction"
    // errors when concurrent callers (e.g. parallel wallet syncs) invoke set/delete/batch.
    const writeSemaphore = yield* Effect.makeSemaphore(1)

    const checkClosed = Effect.gen(function* () {
      const closed = yield* Ref.get(closedRef)
      if (closed) {
        return yield* Effect.fail(new StoreClosedError({message: 'Store is closed'}))
      }
    })

    const store: Store = {
      get: (key: Uint8Array) =>
        Effect.gen(function* () {
          yield* checkClosed

          const row = yield* Effect.tryPromise({
            try: () =>
              handle.with((db) =>
                db.getFirstAsync<{value: Uint8Array}>('SELECT value FROM kv_store WHERE key = ?', [key]),
              ),
            catch: (e) => new StoreError({message: `Failed to get: ${e}`, cause: e}),
          })

          if (!row) {
            return yield* Effect.fail(new KeyNotFoundError({message: 'Key not found', key}))
          }

          // expo-sqlite returns ArrayBuffer, convert to Uint8Array
          return new Uint8Array(row.value)
        }),

      set: (key: Uint8Array, value: Uint8Array) =>
        writeSemaphore.withPermits(1)(
          Effect.gen(function* () {
            yield* checkClosed

            if (value.length === 0) {
              yield* Effect.tryPromise({
                try: () => handle.with((db) => db.runAsync('DELETE FROM kv_store WHERE key = ?', [key])),
                catch: (e) => new StoreError({message: `Failed to delete: ${e}`, cause: e}),
              })
            } else {
              yield* Effect.tryPromise({
                try: () =>
                  handle.with((db) =>
                    db.runAsync('INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)', [key, value]),
                  ),
                catch: (e) => new StoreError({message: `Failed to set: ${e}`, cause: e}),
              })
            }
          }),
        ),

      delete: (key: Uint8Array) =>
        writeSemaphore.withPermits(1)(
          Effect.gen(function* () {
            yield* checkClosed
            yield* Effect.tryPromise({
              try: () => handle.with((db) => db.runAsync('DELETE FROM kv_store WHERE key = ?', [key])),
              catch: (e) => new StoreError({message: `Failed to delete: ${e}`, cause: e}),
            })
          }),
        ),

      has: (key: Uint8Array) =>
        Effect.gen(function* () {
          yield* checkClosed
          const row = yield* Effect.tryPromise({
            try: () =>
              handle.with((db) =>
                db.getFirstAsync<{cnt: number}>('SELECT COUNT(*) as cnt FROM kv_store WHERE key = ?', [key]),
              ),
            catch: (e) => new StoreError({message: `Failed to check: ${e}`, cause: e}),
          })
          return (row?.cnt ?? 0) > 0
        }),

      batch: (ops: ReadonlyArray<BatchOp>) =>
        writeSemaphore.withPermits(1)(
          Effect.gen(function* () {
            yield* checkClosed

            if (ops.length === 0) return

            // Use transaction for atomicity
            yield* Effect.tryPromise({
              try: () =>
                handle.with((db) =>
                  db.withTransactionAsync(async () => {
                    for (const op of ops) {
                      if (op.type === 'del') {
                        await db.runAsync('DELETE FROM kv_store WHERE key = ?', [op.key])
                      } else if (op.value && op.value.length > 0) {
                        await db.runAsync('INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)', [
                          op.key,
                          op.value,
                        ])
                      } else if (op.value?.length === 0) {
                        await db.runAsync('DELETE FROM kv_store WHERE key = ?', [op.key])
                      }
                    }
                  }),
                ),
              catch: (e) => new StoreError({message: `Failed to batch: ${e}`, cause: e}),
            })
          }),
        ),

      iterator: (prefix?: Uint8Array) =>
        Stream.fromEffect(checkClosed).pipe(
          Stream.flatMap(() =>
            Stream.async<[Uint8Array, Uint8Array], StoreErrors>((emit) => {
              ;(async () => {
                try {
                  let rows: Array<{key: Uint8Array; value: Uint8Array}>

                  if (prefix) {
                    // Use hex comparison for prefix matching
                    const prefixHex = bytesToHex(prefix)
                    rows = await handle.with((db) =>
                      db.getAllAsync<{key: Uint8Array; value: Uint8Array}>(
                        `SELECT key, value FROM kv_store WHERE hex(key) LIKE ? || '%' ORDER BY key`,
                        [prefixHex],
                      ),
                    )
                  } else {
                    rows = await handle.with((db) =>
                      db.getAllAsync<{key: Uint8Array; value: Uint8Array}>(
                        'SELECT key, value FROM kv_store ORDER BY key',
                      ),
                    )
                  }

                  for (const row of rows) {
                    emit.single([new Uint8Array(row.key), new Uint8Array(row.value)])
                  }

                  emit.end()
                } catch (e) {
                  emit.fail(new StoreError({message: `Iterator error: ${e}`, cause: e}))
                }
              })()
            }),
          ),
        ),

      close: () =>
        Effect.gen(function* () {
          yield* Ref.set(closedRef, true)
          yield* Effect.tryPromise({
            try: () => handle.close(),
            catch: (e) => new StoreError({message: `Failed to close: ${e}`, cause: e}),
          })
        }),

      scoped: (scopePrefix: Uint8Array) => createScopedStore(store, scopePrefix),
    }

    return StoreService.of(store)
  })
