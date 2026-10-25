/**
 * expo-sqlite implementation of {@link TokenMetadataTable} for React Native.
 *
 * Single `token_metadata` table keyed by `(network, token_id)` — global, no
 * wallet partition. `getMany` chunks its `IN (...)` lookup to stay under
 * SQLite's bound-variable limit when a whale asks for ~15k ids.
 *
 * @module
 */

import {Effect, Ref} from 'effect'
import type * as SQLite from 'expo-sqlite'
import {StoreClosedError, StoreError, type StoreErrors} from './errors.js'
import {openResilientDb} from './expo-sqlite-resilient.native.js'
import {
  TOKEN_METADATA_TABLE_SCHEMA_VERSION,
  type TokenMetadataRow,
  type TokenMetadataTable,
} from './token-metadata-table.js'

/** Chunk size for `IN (...)` lookups — well under SQLite's default 999 var cap. */
const GET_CHUNK = 400

type DbRow = {network: string; token_id: string; detail_json: string; fetched_at: number}

const fromDbRow = (r: DbRow): TokenMetadataRow => ({
  network: r.network,
  tokenId: r.token_id,
  detailJson: r.detail_json,
  fetchedAt: r.fetched_at,
})

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS token_metadata (
    network TEXT NOT NULL,
    token_id TEXT NOT NULL,
    detail_json TEXT NOT NULL,
    fetched_at INTEGER NOT NULL,
    PRIMARY KEY (network, token_id)
  );

  CREATE TABLE IF NOT EXISTS _meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`

const VERSION_KEY = 'token_metadata_table_version'
const DROP_SQL = 'DROP TABLE IF EXISTS token_metadata;'

export const ExpoSQLiteTokenMetadataTable = (
  dbName = 'pnyx-token-metadata.db',
): Effect.Effect<TokenMetadataTable, StoreError> =>
  Effect.gen(function* () {
    const handle = yield* Effect.tryPromise({
      try: () => openResilientDb(dbName, (db) => db.execAsync(SCHEMA_SQL)),
      catch: (e) => new StoreError({message: `Failed to open token-metadata database: ${e}`, cause: e}),
    })

    const storedVersion = yield* Effect.tryPromise({
      try: () =>
        handle.with((db) => db.getFirstAsync<{value: string}>('SELECT value FROM _meta WHERE key = ?', [VERSION_KEY])),
      catch: (e) => new StoreError({message: `Failed to read token-metadata version: ${e}`, cause: e}),
    })

    const storedVersionNum = storedVersion ? Number.parseInt(storedVersion.value, 10) : null
    if (storedVersionNum !== TOKEN_METADATA_TABLE_SCHEMA_VERSION) {
      yield* Effect.tryPromise({
        try: () => handle.with((db) => db.execAsync(DROP_SQL)),
        catch: (e) => new StoreError({message: `Failed to drop token-metadata on version mismatch: ${e}`, cause: e}),
      })
      yield* Effect.tryPromise({
        try: () => handle.with((db) => db.execAsync(SCHEMA_SQL)),
        catch: (e) => new StoreError({message: `Failed to recreate token-metadata schema: ${e}`, cause: e}),
      })
      yield* Effect.tryPromise({
        try: () =>
          handle.with((db) =>
            db.runAsync('INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)', [
              VERSION_KEY,
              String(TOKEN_METADATA_TABLE_SCHEMA_VERSION),
            ]),
          ),
        catch: (e) => new StoreError({message: `Failed to write token-metadata version: ${e}`, cause: e}),
      })
    }

    const closedRef = yield* Ref.make(false)
    const writeSemaphore = yield* Effect.makeSemaphore(1)

    const checkClosed: Effect.Effect<void, StoreErrors> = Effect.gen(function* () {
      if (yield* Ref.get(closedRef)) {
        return yield* Effect.fail(new StoreClosedError({message: 'TokenMetadataTable is closed'}))
      }
    })

    const PUT_SQL =
      'INSERT OR REPLACE INTO token_metadata (network, token_id, detail_json, fetched_at) VALUES (?, ?, ?, ?)'

    const putMany: TokenMetadataTable['putMany'] = (rows) =>
      writeSemaphore.withPermits(1)(
        Effect.gen(function* () {
          yield* checkClosed
          if (rows.length === 0) return
          yield* Effect.tryPromise({
            try: () =>
              handle.with((db) =>
                db.withTransactionAsync(async () => {
                  for (const r of rows) {
                    await db.runAsync(PUT_SQL, [r.network, r.tokenId, r.detailJson, r.fetchedAt])
                  }
                }),
              ),
            catch: (e) => new StoreError({message: `Failed to put token-metadata rows: ${e}`, cause: e}),
          })
        }),
      )

    const getMany: TokenMetadataTable['getMany'] = (network, tokenIds) =>
      Effect.gen(function* () {
        yield* checkClosed
        if (tokenIds.length === 0) return []
        const out: TokenMetadataRow[] = []
        for (let i = 0; i < tokenIds.length; i += GET_CHUNK) {
          const chunk = tokenIds.slice(i, i + GET_CHUNK)
          const placeholders = chunk.map(() => '?').join(',')
          const sql = `SELECT * FROM token_metadata WHERE network = ? AND token_id IN (${placeholders})`
          const rows = yield* Effect.tryPromise({
            try: () => handle.with((db) => db.getAllAsync<DbRow>(sql, [network, ...chunk] as SQLite.SQLiteBindParams)),
            catch: (e) => new StoreError({message: `Failed to get token-metadata rows: ${e}`, cause: e}),
          })
          for (const r of rows) out.push(fromDbRow(r))
        }
        return out
      })

    const clear: TokenMetadataTable['clear'] = (network) =>
      writeSemaphore.withPermits(1)(
        Effect.gen(function* () {
          yield* checkClosed
          yield* Effect.tryPromise({
            try: () => handle.with((db) => db.runAsync('DELETE FROM token_metadata WHERE network = ?', [network])),
            catch: (e) => new StoreError({message: `Failed to clear token-metadata rows: ${e}`, cause: e}),
          })
        }),
      )

    const close: TokenMetadataTable['close'] = () =>
      Effect.gen(function* () {
        const wasClosed = yield* Ref.get(closedRef)
        if (wasClosed) return
        yield* Ref.set(closedRef, true)
        yield* Effect.tryPromise({
          try: () => handle.close(),
          catch: (e) => new StoreError({message: `Failed to close token-metadata database: ${e}`, cause: e}),
        })
      })

    const table: TokenMetadataTable = {putMany, getMany, clear, close}
    return table
  })
