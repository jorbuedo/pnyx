/**
 * IndexedDB implementation of {@link UtxoTable} for web / extension.
 *
 * Backed by a dedicated database (default `pnyx-utxo`) with a single
 * `utxos` object store keyed by the composite
 * `[groupId, chainId, accountIndex, txHash, txIndex]` tuple. A derived
 * `assetsCount` field is indexed so the Plutus-collateral filter
 * (`assets_count = 0`) runs against the index rather than a JS-side scan.
 *
 * Schema versioning piggybacks on IndexedDB's built-in database version
 * mechanism — bumping {@link UTXO_TABLE_SCHEMA_VERSION} triggers
 * `onupgradeneeded` on next open, which drops + recreates the store.
 *
 * @module
 */

import {Effect, Ref} from 'effect'
import {StoreClosedError, StoreError, type StoreErrors} from './errors.js'
import {withIndexedDbOpenRetry} from './idb-open.js'
import {
  UTXO_TABLE_SCHEMA_VERSION,
  type UtxoListQuery,
  type UtxoRef,
  type UtxoRow,
  type UtxoTable,
} from './utxo-table.js'

const STORE_NAME = 'utxos'

/**
 * Internal stored shape — `UtxoRow` plus the derived `assetsCount` field
 * used by the `byAssetsCount` index. Kept off the public `UtxoRow` shape
 * because it's an indexing detail of this adapter, not part of the
 * model.
 */
type StoredRow = UtxoRow & {readonly assetsCount: number}

const toStored = (row: UtxoRow): StoredRow => ({...row, assetsCount: row.assets.length})

const fromStored = (row: StoredRow): UtxoRow => {
  const {assetsCount: _ignored, ...rest} = row
  return rest
}

const refMatches = (row: UtxoRow, ref: UtxoRef): boolean =>
  row.groupId === ref.groupId && row.chainId === ref.chainId && row.accountIndex === ref.accountIndex

const passesFilters = (row: UtxoRow, q: UtxoListQuery): boolean => {
  if (q.pureOnly === true && row.assets.length > 0) return false
  return true
}

/**
 * Open the UTXOs table on the given IndexedDB database.
 *
 * Defaults to `pnyx-utxo` — a dedicated database name so schema bumps
 * drop our store cleanly without touching other dbs.
 */
export const IndexedDBUtxoTable = (dbName = 'pnyx-utxo'): Effect.Effect<UtxoTable, StoreError> =>
  Effect.gen(function* () {
    const db = yield* withIndexedDbOpenRetry(
      Effect.tryPromise({
        try: () =>
          new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open(dbName, UTXO_TABLE_SCHEMA_VERSION)
            // Settle exactly once. A rejected `onblocked` open can still resolve
            // later when the blocking connection closes; close that late
            // connection so a rejected-then-retried open can't orphan an IDB.
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
            // A concurrent connection blocks this open (e.g. a schema bump while
            // another tab holds the old version); reject so the retry re-attempts.
            request.onblocked = () => {
              if (settled) return
              settled = true
              reject(new Error('utxo-table IndexedDB open blocked by another connection'))
            }
            request.onupgradeneeded = () => {
              const upgrading = request.result
              if (upgrading.objectStoreNames.contains(STORE_NAME)) {
                upgrading.deleteObjectStore(STORE_NAME)
              }
              const store = upgrading.createObjectStore(STORE_NAME, {
                keyPath: ['groupId', 'chainId', 'accountIndex', 'txHash', 'txIndex'],
              })
              // Workhorse index for the collateral filter — pureOnly queries
              // walk the partition entries with assetsCount = 0 instead of
              // materializing every UTXO and filtering in JS.
              store.createIndex('byAssetsCount', ['groupId', 'chainId', 'accountIndex', 'assetsCount'], {unique: false})
            }
          }),
        catch: (e) => new StoreError({message: `Failed to open utxo-table IndexedDB: ${e}`, cause: e}),
      }),
    )

    const closedRef = yield* Ref.make(false)

    const checkClosed: Effect.Effect<void, StoreErrors> = Effect.gen(function* () {
      if (yield* Ref.get(closedRef)) {
        return yield* Effect.fail(new StoreClosedError({message: 'UtxoTable is closed'}))
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

    const put: UtxoTable['put'] = (row) =>
      Effect.gen(function* () {
        yield* checkClosed
        yield* Effect.tryPromise({
          try: () => runIDB('readwrite', (store) => awaitRequest(store.put(toStored(row)))),
          catch: (e) => new StoreError({message: `Failed to put utxo row: ${e}`, cause: e}),
        })
      })

    const putMany: UtxoTable['putMany'] = (rows) =>
      Effect.gen(function* () {
        yield* checkClosed
        if (rows.length === 0) return
        yield* Effect.tryPromise({
          try: () =>
            runIDB('readwrite', async (store) => {
              for (const row of rows) {
                store.put(toStored(row))
              }
            }),
          catch: (e) => new StoreError({message: `Failed to put utxo rows: ${e}`, cause: e}),
        })
      })

    const deleteRows: UtxoTable['delete'] = (ref, keys) =>
      Effect.gen(function* () {
        yield* checkClosed
        if (keys.length === 0) return
        yield* Effect.tryPromise({
          try: () =>
            runIDB('readwrite', async (store) => {
              for (const k of keys) {
                store.delete([ref.groupId, ref.chainId, ref.accountIndex, k.txHash, k.txIndex])
              }
            }),
          catch: (e) => new StoreError({message: `Failed to delete utxo rows: ${e}`, cause: e}),
        })
      })

    const replaceAll: UtxoTable['replaceAll'] = (ref, rows) =>
      Effect.gen(function* () {
        yield* checkClosed
        // Atomic clear + insert within a single readwrite transaction.
        yield* Effect.tryPromise({
          try: () =>
            runIDB('readwrite', async (store) => {
              const idx = store.index('byAssetsCount')
              const lower = [ref.groupId, ref.chainId, ref.accountIndex, Number.NEGATIVE_INFINITY]
              const upper = [ref.groupId, ref.chainId, ref.accountIndex, Number.POSITIVE_INFINITY]
              const range = IDBKeyRange.bound(lower, upper)
              const cursorReq = idx.openCursor(range)
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
              for (const row of rows) {
                store.put(toStored(row))
              }
            }),
          catch: (e) => new StoreError({message: `Failed to replace utxo rows: ${e}`, cause: e}),
        })
      })

    const listInternal = (q: UtxoListQuery): Promise<UtxoRow[]> =>
      runIDB('readonly', async (store) => {
        const idx = store.index('byAssetsCount')
        const lower =
          q.pureOnly === true
            ? [q.groupId, q.chainId, q.accountIndex, 0]
            : [q.groupId, q.chainId, q.accountIndex, Number.NEGATIVE_INFINITY]
        const upper =
          q.pureOnly === true
            ? [q.groupId, q.chainId, q.accountIndex, 0]
            : [q.groupId, q.chainId, q.accountIndex, Number.POSITIVE_INFINITY]
        const range = IDBKeyRange.bound(lower, upper)
        const results: UtxoRow[] = []
        const cursorReq = idx.openCursor(range)
        await new Promise<void>((resolve, reject) => {
          cursorReq.onsuccess = () => {
            const cursor = cursorReq.result
            if (!cursor) {
              resolve()
              return
            }
            const stored = cursor.value as StoredRow
            const row = fromStored(stored)
            if (passesFilters(row, q)) results.push(row)
            cursor.continue()
          }
          cursorReq.onerror = () => reject(cursorReq.error)
        })
        return results
      })

    const list: UtxoTable['list'] = (q) =>
      Effect.gen(function* () {
        yield* checkClosed
        return yield* Effect.tryPromise({
          try: () => listInternal(q),
          catch: (e) => new StoreError({message: `Failed to list utxo rows: ${e}`, cause: e}),
        })
      })

    const count: UtxoTable['count'] = (ref) =>
      Effect.gen(function* () {
        yield* checkClosed
        return yield* Effect.tryPromise({
          try: () =>
            runIDB('readonly', async (store) => {
              const idx = store.index('byAssetsCount')
              const lower = [ref.groupId, ref.chainId, ref.accountIndex, Number.NEGATIVE_INFINITY]
              const upper = [ref.groupId, ref.chainId, ref.accountIndex, Number.POSITIVE_INFINITY]
              const range = IDBKeyRange.bound(lower, upper)
              return await awaitRequest(idx.count(range))
            }),
          catch: (e) => new StoreError({message: `Failed to count utxo rows: ${e}`, cause: e}),
        })
      })

    const clear: UtxoTable['clear'] = (ref) =>
      Effect.gen(function* () {
        yield* checkClosed
        yield* Effect.tryPromise({
          try: () =>
            runIDB('readwrite', async (store) => {
              const idx = store.index('byAssetsCount')
              const lower = [ref.groupId, ref.chainId, ref.accountIndex, Number.NEGATIVE_INFINITY]
              const upper = [ref.groupId, ref.chainId, ref.accountIndex, Number.POSITIVE_INFINITY]
              const range = IDBKeyRange.bound(lower, upper)
              const cursorReq = idx.openCursor(range)
              await new Promise<void>((resolve, reject) => {
                cursorReq.onsuccess = () => {
                  const cursor = cursorReq.result
                  if (!cursor) {
                    resolve()
                    return
                  }
                  if (refMatches(cursor.value as StoredRow, ref)) {
                    cursor.delete()
                  }
                  cursor.continue()
                }
                cursorReq.onerror = () => reject(cursorReq.error)
              })
            }),
          catch: (e) => new StoreError({message: `Failed to clear utxo rows: ${e}`, cause: e}),
        })
      })

    const close: UtxoTable['close'] = () =>
      Effect.gen(function* () {
        const wasClosed = yield* Ref.get(closedRef)
        if (wasClosed) return
        yield* Ref.set(closedRef, true)
        db.close()
      })

    const table: UtxoTable = {put, putMany, delete: deleteRows, replaceAll, list, count, clear, close}
    return table
  })
