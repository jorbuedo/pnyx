/**
 * IndexedDB implementation of {@link AssetsTable} for web / extension.
 *
 * Backed by a dedicated database (default `pnyx-assets`) with a single
 * `assets` object store keyed by `[groupId, chainId, accountIndex, id]`. A
 * `byValue` index on `[groupId, chainId, accountIndex, usdValue]` backs the
 * default holdings sort (iterated in `'prev'` direction for usdValue desc),
 * so `list` pages the top holdings without a JS-side sort of the full set.
 *
 * Schema versioning piggybacks on IndexedDB's database-version mechanism —
 * bumping {@link ASSETS_TABLE_SCHEMA_VERSION} triggers `onupgradeneeded`,
 * which drops + recreates the store.
 *
 * @module
 */

import {Effect, Ref} from 'effect'
import {ASSETS_TABLE_SCHEMA_VERSION, type AssetRef, type AssetRow, type AssetsTable} from './assets-table.js'
import {StoreClosedError, StoreError, type StoreErrors} from './errors.js'
import {withIndexedDbOpenRetry} from './idb-open.js'

const STORE_NAME = 'assets'

const refRange = (ref: AssetRef): IDBKeyRange =>
  IDBKeyRange.bound(
    [ref.groupId, ref.chainId, ref.accountIndex, Number.NEGATIVE_INFINITY],
    [ref.groupId, ref.chainId, ref.accountIndex, Number.POSITIVE_INFINITY],
  )

export const IndexedDBAssetsTable = (dbName = 'pnyx-assets'): Effect.Effect<AssetsTable, StoreError> =>
  Effect.gen(function* () {
    const db = yield* withIndexedDbOpenRetry(
      Effect.tryPromise({
        try: () =>
          new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open(dbName, ASSETS_TABLE_SCHEMA_VERSION)
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
              reject(new Error('assets-table IndexedDB open blocked by another connection'))
            }
            request.onupgradeneeded = () => {
              const upgrading = request.result
              if (upgrading.objectStoreNames.contains(STORE_NAME)) {
                upgrading.deleteObjectStore(STORE_NAME)
              }
              const store = upgrading.createObjectStore(STORE_NAME, {
                keyPath: ['groupId', 'chainId', 'accountIndex', 'id'],
              })
              store.createIndex('byValue', ['groupId', 'chainId', 'accountIndex', 'usdValue'], {unique: false})
            }
          }),
        catch: (e) => new StoreError({message: `Failed to open assets-table IndexedDB: ${e}`, cause: e}),
      }),
    )

    const closedRef = yield* Ref.make(false)

    const checkClosed: Effect.Effect<void, StoreErrors> = Effect.gen(function* () {
      if (yield* Ref.get(closedRef)) {
        return yield* Effect.fail(new StoreClosedError({message: 'AssetsTable is closed'}))
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

    const deletePartition = (store: IDBObjectStore, ref: AssetRef): Promise<void> => {
      const cursorReq = store.index('byValue').openCursor(refRange(ref))
      return new Promise<void>((resolve, reject) => {
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
    }

    const replaceAll: AssetsTable['replaceAll'] = (ref, rows) =>
      Effect.gen(function* () {
        yield* checkClosed
        yield* Effect.tryPromise({
          try: () =>
            runIDB('readwrite', async (store) => {
              await deletePartition(store, ref)
              for (const row of rows) {
                store.put(row)
              }
            }),
          catch: (e) => new StoreError({message: `Failed to replace asset rows: ${e}`, cause: e}),
        })
      })

    const list: AssetsTable['list'] = (q) =>
      Effect.gen(function* () {
        yield* checkClosed
        return yield* Effect.tryPromise({
          try: () =>
            runIDB('readonly', async (store) => {
              // 'prev' walks the byValue index high→low → usdValue descending.
              const cursorReq = store.index('byValue').openCursor(refRange(q), 'prev')
              const results: AssetRow[] = []
              const offset = q.offset ?? 0
              let skipped = 0
              await new Promise<void>((resolve, reject) => {
                cursorReq.onsuccess = () => {
                  const cursor = cursorReq.result
                  if (!cursor) {
                    resolve()
                    return
                  }
                  if (q.limit != null && results.length >= q.limit) {
                    resolve()
                    return
                  }
                  if (skipped < offset) {
                    skipped += 1
                  } else {
                    results.push(cursor.value as AssetRow)
                  }
                  cursor.continue()
                }
                cursorReq.onerror = () => reject(cursorReq.error)
              })
              return results
            }),
          catch: (e) => new StoreError({message: `Failed to list asset rows: ${e}`, cause: e}),
        })
      })

    const count: AssetsTable['count'] = (ref) =>
      Effect.gen(function* () {
        yield* checkClosed
        return yield* Effect.tryPromise({
          try: () =>
            runIDB('readonly', async (store) => {
              const req = store.index('byValue').count(refRange(ref))
              return await new Promise<number>((resolve, reject) => {
                req.onsuccess = () => resolve(req.result)
                req.onerror = () => reject(req.error)
              })
            }),
          catch: (e) => new StoreError({message: `Failed to count asset rows: ${e}`, cause: e}),
        })
      })

    const clear: AssetsTable['clear'] = (ref) =>
      Effect.gen(function* () {
        yield* checkClosed
        yield* Effect.tryPromise({
          try: () => runIDB('readwrite', (store) => deletePartition(store, ref)),
          catch: (e) => new StoreError({message: `Failed to clear asset rows: ${e}`, cause: e}),
        })
      })

    const close: AssetsTable['close'] = () =>
      Effect.gen(function* () {
        const wasClosed = yield* Ref.get(closedRef)
        if (wasClosed) return
        yield* Ref.set(closedRef, true)
        db.close()
      })

    const table: AssetsTable = {replaceAll, list, count, clear, close}
    return table
  })
