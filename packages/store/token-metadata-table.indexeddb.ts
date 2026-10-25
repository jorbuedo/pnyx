/**
 * IndexedDB implementation of {@link TokenMetadataTable} for web / extension.
 *
 * Single `token_metadata` object store keyed by `[network, tokenId]` — global,
 * no wallet partition. `getMany` issues a direct keyed `get` per id within one
 * readonly transaction (IDB point lookups are cheap); `clear` walks the
 * network's key range.
 *
 * @module
 */

import {Effect, Ref} from 'effect'
import {StoreClosedError, StoreError, type StoreErrors} from './errors.js'
import {withIndexedDbOpenRetry} from './idb-open.js'
import {
  TOKEN_METADATA_TABLE_SCHEMA_VERSION,
  type TokenMetadataRow,
  type TokenMetadataTable,
} from './token-metadata-table.js'

const STORE_NAME = 'token_metadata'

export const IndexedDBTokenMetadataTable = (
  dbName = 'pnyx-token-metadata',
): Effect.Effect<TokenMetadataTable, StoreError> =>
  Effect.gen(function* () {
    const db = yield* withIndexedDbOpenRetry(
      Effect.tryPromise({
        try: () =>
          new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open(dbName, TOKEN_METADATA_TABLE_SCHEMA_VERSION)
            let settled = false
            request.onerror = () => {
              if (settled) return
              settled = true
              reject(request.error)
            }
            request.onsuccess = () => {
              if (settled) {
                request.result.close()
                return
              }
              settled = true
              resolve(request.result)
            }
            request.onblocked = () => {
              if (settled) return
              settled = true
              reject(new Error('token-metadata IndexedDB open blocked by another connection'))
            }
            request.onupgradeneeded = () => {
              const upgrading = request.result
              if (upgrading.objectStoreNames.contains(STORE_NAME)) {
                upgrading.deleteObjectStore(STORE_NAME)
              }
              upgrading.createObjectStore(STORE_NAME, {keyPath: ['network', 'tokenId']})
            }
          }),
        catch: (e) => new StoreError({message: `Failed to open token-metadata IndexedDB: ${e}`, cause: e}),
      }),
    )

    const closedRef = yield* Ref.make(false)

    const checkClosed: Effect.Effect<void, StoreErrors> = Effect.gen(function* () {
      if (yield* Ref.get(closedRef)) {
        return yield* Effect.fail(new StoreClosedError({message: 'TokenMetadataTable is closed'}))
      }
    })

    const runIDB = <T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => Promise<T>): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, mode)
        const store = tx.objectStore(STORE_NAME)
        let result: T
        let failed = false
        fn(store).then(
          (r) => {
            result = r
          },
          (err) => {
            failed = true
            reject(err)
            tx.abort()
          },
        )
        tx.oncomplete = () => {
          if (!failed) resolve(result)
        }
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => {
          if (!failed) reject(tx.error ?? new Error('IndexedDB transaction aborted'))
        }
      })

    const awaitRequest = <T>(req: IDBRequest<T>): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })

    const putMany: TokenMetadataTable['putMany'] = (rows) =>
      Effect.gen(function* () {
        yield* checkClosed
        if (rows.length === 0) return
        yield* Effect.tryPromise({
          try: () =>
            runIDB('readwrite', async (store) => {
              for (const r of rows) store.put(r)
            }),
          catch: (e) => new StoreError({message: `Failed to put token-metadata rows: ${e}`, cause: e}),
        })
      })

    const getMany: TokenMetadataTable['getMany'] = (network, tokenIds) =>
      Effect.gen(function* () {
        yield* checkClosed
        if (tokenIds.length === 0) return []
        return yield* Effect.tryPromise({
          try: () =>
            runIDB('readonly', async (store) => {
              const out: TokenMetadataRow[] = []
              for (const id of tokenIds) {
                const row = (await awaitRequest(store.get([network, id]))) as TokenMetadataRow | undefined
                if (row) out.push(row)
              }
              return out
            }),
          catch: (e) => new StoreError({message: `Failed to get token-metadata rows: ${e}`, cause: e}),
        })
      })

    const clear: TokenMetadataTable['clear'] = (network) =>
      Effect.gen(function* () {
        yield* checkClosed
        yield* Effect.tryPromise({
          try: () =>
            runIDB('readwrite', async (store) => {
              const range = IDBKeyRange.bound([network, ''], [network, '￿'])
              const cursorReq = store.openCursor(range)
              await new Promise<void>((resolve, reject) => {
                cursorReq.onsuccess = () => {
                  const cursor = cursorReq.result
                  if (!cursor) {
                    resolve()
                    return
                  }
                  cursor.delete()
                  cursor.continue()
                }
                cursorReq.onerror = () => reject(cursorReq.error)
              })
            }),
          catch: (e) => new StoreError({message: `Failed to clear token-metadata rows: ${e}`, cause: e}),
        })
      })

    const close: TokenMetadataTable['close'] = () =>
      Effect.gen(function* () {
        const wasClosed = yield* Ref.get(closedRef)
        if (wasClosed) return
        yield* Ref.set(closedRef, true)
        db.close()
      })

    const table: TokenMetadataTable = {putMany, getMany, clear, close}
    return table
  })
