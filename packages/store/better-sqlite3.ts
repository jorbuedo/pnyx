/**
 * SQLite-based store for Node.js/Bun using better-sqlite3.
 *
 * Provides consistent SQL interface with mobile expo-sqlite.
 * Used for server-side applications and testing.
 *
 * @module
 */

import {Effect, Ref, Stream} from 'effect'
import {KeyNotFoundError, StoreClosedError, StoreError, type StoreErrors} from './errors.js'
import {type BatchOp, createScopedStore, type Store, StoreService} from './store.js'

/**
 * better-sqlite3 Statement interface.
 */
type Statement<T> = {
  run(...params: unknown[]): {lastInsertRowid: number; changes: number}
  get(...params: unknown[]): T | undefined
  all(...params: unknown[]): T[]
}

/**
 * better-sqlite3 Database interface.
 */
type BetterSqlite3Database = {
  exec(sql: string): void
  prepare<T>(sql: string): Statement<T>
  close(): void
  transaction<T>(fn: () => T): () => T
}

/**
 * better-sqlite3 module default export.
 */
type BetterSqlite3Constructor = new (path: string, options?: {readonly?: boolean}) => BetterSqlite3Database

/**
 * Convert Uint8Array to hex string for SQL BLOB comparison.
 */
const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()

/**
 * Create a SQLite-based store using better-sqlite3.
 *
 * @param dbPath - Database file path (default: 'pnyx.db')
 */
export const BetterSqlite3Store = (dbPath = 'pnyx.db'): Effect.Effect<typeof StoreService.Service, StoreError> =>
  Effect.gen(function* () {
    // Dynamically import better-sqlite3
    // Using variable to prevent TypeScript from trying to resolve the module at compile time
    const moduleName = 'better-sqlite3'
    const Database: BetterSqlite3Constructor = yield* Effect.tryPromise({
      try: async () => {
        const mod = await import(/* webpackIgnore: true */ moduleName)
        // Handle both ESM default and CommonJS
        return (mod.default ?? mod) as BetterSqlite3Constructor
      },
      catch: (e) => new StoreError({message: `Failed to import better-sqlite3: ${e}`, cause: e}),
    })

    const db = yield* Effect.try({
      try: () => new Database(dbPath),
      catch: (e) => new StoreError({message: `Failed to open database: ${e}`, cause: e}),
    })

    // Create table with WAL mode for better performance
    yield* Effect.try({
      try: () => {
        db.exec('PRAGMA journal_mode = WAL')
        db.exec(`
          CREATE TABLE IF NOT EXISTS kv_store (
            key BLOB PRIMARY KEY,
            value BLOB NOT NULL
          )
        `)
        db.exec('CREATE INDEX IF NOT EXISTS idx_kv_key_hex ON kv_store(hex(key))')
      },
      catch: (e) => new StoreError({message: `Failed to create table: ${e}`, cause: e}),
    })

    const closedRef = yield* Ref.make(false)

    const checkClosed = Effect.gen(function* () {
      const closed = yield* Ref.get(closedRef)
      if (closed) {
        return yield* Effect.fail(new StoreClosedError({message: 'Store is closed'}))
      }
    })

    // Prepare statements for performance
    const stmts = {
      get: db.prepare<{value: Buffer}>('SELECT value FROM kv_store WHERE key = ?'),
      set: db.prepare('INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)'),
      del: db.prepare('DELETE FROM kv_store WHERE key = ?'),
      has: db.prepare<{cnt: number}>('SELECT COUNT(*) as cnt FROM kv_store WHERE key = ?'),
      all: db.prepare<{key: Buffer; value: Buffer}>('SELECT key, value FROM kv_store ORDER BY key'),
      prefix: db.prepare<{key: Buffer; value: Buffer}>(
        `SELECT key, value FROM kv_store WHERE hex(key) LIKE ? || '%' ORDER BY key`,
      ),
    }

    const store: Store = {
      get: (key: Uint8Array) =>
        Effect.gen(function* () {
          yield* checkClosed

          const row = yield* Effect.try({
            try: () => stmts.get.get(Buffer.from(key)),
            catch: (e) => new StoreError({message: `Failed to get: ${e}`, cause: e}),
          })

          if (!row) {
            return yield* Effect.fail(new KeyNotFoundError({message: 'Key not found', key}))
          }

          return new Uint8Array(row.value)
        }),

      set: (key: Uint8Array, value: Uint8Array) =>
        Effect.gen(function* () {
          yield* checkClosed

          yield* Effect.try({
            try: () => {
              if (value.length === 0) {
                stmts.del.run(Buffer.from(key))
              } else {
                stmts.set.run(Buffer.from(key), Buffer.from(value))
              }
            },
            catch: (e) => new StoreError({message: `Failed to set: ${e}`, cause: e}),
          })
        }),

      delete: (key: Uint8Array) =>
        Effect.gen(function* () {
          yield* checkClosed
          yield* Effect.try({
            try: () => stmts.del.run(Buffer.from(key)),
            catch: (e) => new StoreError({message: `Failed to delete: ${e}`, cause: e}),
          })
        }),

      has: (key: Uint8Array) =>
        Effect.gen(function* () {
          yield* checkClosed
          const row = yield* Effect.try({
            try: () => stmts.has.get(Buffer.from(key)),
            catch: (e) => new StoreError({message: `Failed to check: ${e}`, cause: e}),
          })
          return (row?.cnt ?? 0) > 0
        }),

      batch: (ops: ReadonlyArray<BatchOp>) =>
        Effect.gen(function* () {
          yield* checkClosed

          if (ops.length === 0) return

          // Use transaction for atomicity
          const runBatch = db.transaction(() => {
            for (const op of ops) {
              if (op.type === 'del') {
                stmts.del.run(Buffer.from(op.key))
              } else if (op.value && op.value.length > 0) {
                stmts.set.run(Buffer.from(op.key), Buffer.from(op.value))
              } else if (op.value?.length === 0) {
                stmts.del.run(Buffer.from(op.key))
              }
            }
          })

          yield* Effect.try({
            try: () => runBatch(),
            catch: (e) => new StoreError({message: `Failed to batch: ${e}`, cause: e}),
          })
        }),

      iterator: (prefix?: Uint8Array) =>
        Stream.fromEffect(checkClosed).pipe(
          Stream.flatMap(() =>
            Stream.async<[Uint8Array, Uint8Array], StoreErrors>((emit) => {
              try {
                let rows: Array<{key: Buffer; value: Buffer}>

                if (prefix) {
                  const prefixHex = bytesToHex(prefix)
                  rows = stmts.prefix.all(prefixHex)
                } else {
                  rows = stmts.all.all()
                }

                for (const row of rows) {
                  emit.single([new Uint8Array(row.key), new Uint8Array(row.value)])
                }

                emit.end()
              } catch (e) {
                emit.fail(new StoreError({message: `Iterator error: ${e}`, cause: e}))
              }
            }),
          ),
        ),

      close: () =>
        Effect.gen(function* () {
          yield* Ref.set(closedRef, true)
          yield* Effect.try({
            try: () => db.close(),
            catch: (e) => new StoreError({message: `Failed to close: ${e}`, cause: e}),
          })
        }),

      scoped: (scopePrefix: Uint8Array) => createScopedStore(store, scopePrefix),
    }

    return StoreService.of(store)
  })
