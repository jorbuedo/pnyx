/**
 * IndexedDB implementation of {@link PricePointTable} for web / extension.
 *
 * Single `price_point` object store keyed by `[network, seriesKey, tsBucket]`,
 * so a bounded key range gives a series' points ascending by bucket for free.
 *
 * @module
 */

import {Effect, Ref} from 'effect'
import {StoreClosedError, StoreError, type StoreErrors} from './errors.js'
import {withIndexedDbOpenRetry} from './idb-open.js'
import {PRICE_POINT_TABLE_SCHEMA_VERSION, type PricePointRow, type PricePointTable} from './price-point-table.js'

const STORE_NAME = 'price_point'
const MAX_TS = Number.MAX_SAFE_INTEGER

export const IndexedDBPricePointTable = (dbName = 'pnyx-price-point'): Effect.Effect<PricePointTable, StoreError> =>
  Effect.gen(function* () {
    const db = yield* withIndexedDbOpenRetry(
      Effect.tryPromise({
        try: () =>
          new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open(dbName, PRICE_POINT_TABLE_SCHEMA_VERSION)
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
              reject(new Error('price-point IndexedDB open blocked by another connection'))
            }
            request.onupgradeneeded = () => {
              const upgrading = request.result
              if (upgrading.objectStoreNames.contains(STORE_NAME)) {
                upgrading.deleteObjectStore(STORE_NAME)
              }
              upgrading.createObjectStore(STORE_NAME, {keyPath: ['network', 'seriesKey', 'tsBucket']})
            }
          }),
        catch: (e) => new StoreError({message: `Failed to open price-point IndexedDB: ${e}`, cause: e}),
      }),
    )

    const closedRef = yield* Ref.make(false)

    const checkClosed: Effect.Effect<void, StoreErrors> = Effect.gen(function* () {
      if (yield* Ref.get(closedRef)) {
        return yield* Effect.fail(new StoreClosedError({message: 'PricePointTable is closed'}))
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

    const deleteRange = (store: IDBObjectStore, range: IDBKeyRange): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        const cursorReq = store.openCursor(range)
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

    const putMany: PricePointTable['putMany'] = (rows) =>
      Effect.gen(function* () {
        yield* checkClosed
        if (rows.length === 0) return
        yield* Effect.tryPromise({
          try: () =>
            runIDB('readwrite', async (store) => {
              for (const r of rows) store.put(r)
            }),
          catch: (e) => new StoreError({message: `Failed to put price-point rows: ${e}`, cause: e}),
        })
      })

    const getRange: PricePointTable['getRange'] = (network, seriesKey, fromTsBucket, toTsBucket) =>
      Effect.gen(function* () {
        yield* checkClosed
        return yield* Effect.tryPromise({
          try: () =>
            runIDB('readonly', async (store) => {
              const range = IDBKeyRange.bound([network, seriesKey, fromTsBucket], [network, seriesKey, toTsBucket])
              const out: PricePointRow[] = []
              await new Promise<void>((resolve, reject) => {
                const cursorReq = store.openCursor(range)
                cursorReq.onsuccess = () => {
                  const cursor = cursorReq.result
                  if (!cursor) {
                    resolve()
                    return
                  }
                  out.push(cursor.value as PricePointRow)
                  cursor.continue()
                }
                cursorReq.onerror = () => reject(cursorReq.error)
              })
              return out
            }),
          catch: (e) => new StoreError({message: `Failed to get price-point range: ${e}`, cause: e}),
        })
      })

    const prune: PricePointTable['prune'] = (network, seriesKey, beforeTsBucket) =>
      Effect.gen(function* () {
        yield* checkClosed
        yield* Effect.tryPromise({
          try: () =>
            runIDB('readwrite', async (store) => {
              // [.,.,0] … [.,.,beforeTsBucket) — upper-open so `beforeTsBucket` is kept.
              const range = IDBKeyRange.bound(
                [network, seriesKey, 0],
                [network, seriesKey, beforeTsBucket],
                false,
                true,
              )
              await deleteRange(store, range)
            }),
          catch: (e) => new StoreError({message: `Failed to prune price-point rows: ${e}`, cause: e}),
        })
      })

    const clear: PricePointTable['clear'] = (network) =>
      Effect.gen(function* () {
        yield* checkClosed
        yield* Effect.tryPromise({
          try: () =>
            runIDB('readwrite', async (store) => {
              const range = IDBKeyRange.bound([network, '', 0], [network, '￿', MAX_TS])
              await deleteRange(store, range)
            }),
          catch: (e) => new StoreError({message: `Failed to clear price-point rows: ${e}`, cause: e}),
        })
      })

    const close: PricePointTable['close'] = () =>
      Effect.gen(function* () {
        const wasClosed = yield* Ref.get(closedRef)
        if (wasClosed) return
        yield* Ref.set(closedRef, true)
        db.close()
      })

    const table: PricePointTable = {putMany, getRange, prune, clear, close}
    return table
  })
