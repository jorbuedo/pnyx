/**
 * IndexedDB implementation of {@link AddressTable} for web / extension.
 *
 * Backed by a dedicated database (default `pnyx-address`) with a single
 * `addresses` object store keyed by the composite
 * `[groupId, chainId, accountIndex, branch, index]` tuple. Two indexes:
 *  - `byChainUsed` on `[chainId, isUsedKey]` — drives the cross-wallet
 *    airdrop scan.
 *  - `byPartitionBranchUsed` on
 *    `[groupId, chainId, accountIndex, branch, isUsedKey]` — drives
 *    per-wallet `getUsedAddresses` / `getUnusedAddresses`.
 *
 * IndexedDB index keys cannot be booleans on every browser, so the stored
 * row carries a derived numeric `isUsedKey` (0/1) used only for indexing.
 *
 * Schema versioning piggybacks on IndexedDB's built-in database version
 * mechanism — bumping {@link ADDRESS_TABLE_SCHEMA_VERSION} triggers
 * `onupgradeneeded` on next open, which drops + recreates the store.
 *
 * @module
 */

import {Effect, Ref} from 'effect'
import {
  ADDRESS_TABLE_SCHEMA_VERSION,
  type AddressListQuery,
  type AddressRef,
  type AddressRow,
  type AddressTable,
} from './address-table.js'
import {StoreClosedError, StoreError, type StoreErrors} from './errors.js'
import {withIndexedDbOpenRetry} from './idb-open.js'

const STORE_NAME = 'addresses'

/**
 * Internal stored shape — `AddressRow` plus a numeric `isUsedKey` mirror
 * of `isUsed` used by the two indexes. Booleans aren't reliable as index
 * keys across browsers, so we materialize a 0/1 column.
 */
type StoredRow = AddressRow & {readonly isUsedKey: number}

const toStored = (row: AddressRow): StoredRow => ({...row, isUsedKey: row.isUsed ? 1 : 0})

const fromStored = (row: StoredRow): AddressRow => {
  const {isUsedKey: _ignored, ...rest} = row
  return rest
}

const refMatches = (row: AddressRow, ref: AddressRef): boolean =>
  row.groupId === ref.groupId && row.chainId === ref.chainId && row.accountIndex === ref.accountIndex

const passesFilters = (row: AddressRow, q: AddressListQuery): boolean => {
  if (q.groupId !== undefined && row.groupId !== q.groupId) return false
  if (q.chainId !== undefined && row.chainId !== q.chainId) return false
  if (q.accountIndex !== undefined && row.accountIndex !== q.accountIndex) return false
  if (q.branch !== undefined && row.branch !== q.branch) return false
  if (q.isUsed !== undefined && row.isUsed !== q.isUsed) return false
  return true
}

const sortRows = (rows: AddressRow[]): AddressRow[] => {
  rows.sort((a, b) => {
    if (a.groupId !== b.groupId) return a.groupId.localeCompare(b.groupId)
    if (a.chainId !== b.chainId) return a.chainId.localeCompare(b.chainId)
    if (a.accountIndex !== b.accountIndex) return a.accountIndex - b.accountIndex
    if (a.branch !== b.branch) return a.branch.localeCompare(b.branch)
    return a.index - b.index
  })
  return rows
}

/**
 * Open the addresses table on the given IndexedDB database.
 *
 * Defaults to `pnyx-address` — a dedicated database name so schema
 * bumps drop our store cleanly without touching other dbs.
 */
export const IndexedDBAddressTable = (dbName = 'pnyx-address'): Effect.Effect<AddressTable, StoreError> =>
  Effect.gen(function* () {
    const db = yield* withIndexedDbOpenRetry(
      Effect.tryPromise({
        try: () =>
          new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open(dbName, ADDRESS_TABLE_SCHEMA_VERSION)
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
              reject(new Error('address-table IndexedDB open blocked by another connection'))
            }
            request.onupgradeneeded = () => {
              const upgrading = request.result
              if (upgrading.objectStoreNames.contains(STORE_NAME)) {
                upgrading.deleteObjectStore(STORE_NAME)
              }
              const store = upgrading.createObjectStore(STORE_NAME, {
                keyPath: ['groupId', 'chainId', 'accountIndex', 'branch', 'index'],
              })
              store.createIndex('byChainUsed', ['chainId', 'isUsedKey'], {unique: false})
              store.createIndex(
                'byPartitionBranchUsed',
                ['groupId', 'chainId', 'accountIndex', 'branch', 'isUsedKey'],
                {
                  unique: false,
                },
              )
            }
          }),
        catch: (e) => new StoreError({message: `Failed to open address-table IndexedDB: ${e}`, cause: e}),
      }),
    )

    const closedRef = yield* Ref.make(false)

    const checkClosed: Effect.Effect<void, StoreErrors> = Effect.gen(function* () {
      if (yield* Ref.get(closedRef)) {
        return yield* Effect.fail(new StoreClosedError({message: 'AddressTable is closed'}))
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

    const upsert: AddressTable['upsert'] = (row) =>
      Effect.gen(function* () {
        yield* checkClosed
        yield* Effect.tryPromise({
          try: () => runIDB('readwrite', (store) => awaitRequest(store.put(toStored(row)))),
          catch: (e) => new StoreError({message: `Failed to upsert address row: ${e}`, cause: e}),
        })
      })

    const upsertMany: AddressTable['upsertMany'] = (rows) =>
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
          catch: (e) => new StoreError({message: `Failed to upsert address rows: ${e}`, cause: e}),
        })
      })

    type CursorRange = {indexName: string; range: IDBKeyRange | null}

    const pickRange = (q: AddressListQuery): CursorRange => {
      // Prefer the most-selective index that matches the filter. The two
      // hot paths we shape for:
      //   - cross-wallet airdrop scan: chainId + isUsed → byChainUsed
      //   - per-wallet used/unused:    full ref + branch + isUsed → byPartitionBranchUsed
      // Anything else falls back to a full scan (cursor over primary key).
      if (
        q.groupId !== undefined &&
        q.chainId !== undefined &&
        q.accountIndex !== undefined &&
        q.branch !== undefined &&
        q.isUsed !== undefined
      ) {
        const key = [q.groupId, q.chainId, q.accountIndex, q.branch, q.isUsed ? 1 : 0]
        return {indexName: 'byPartitionBranchUsed', range: IDBKeyRange.only(key)}
      }
      if (q.chainId !== undefined && q.isUsed !== undefined) {
        return {indexName: 'byChainUsed', range: IDBKeyRange.only([q.chainId, q.isUsed ? 1 : 0])}
      }
      if (q.chainId !== undefined) {
        return {
          indexName: 'byChainUsed',
          range: IDBKeyRange.bound([q.chainId, 0], [q.chainId, 1]),
        }
      }
      return {indexName: '', range: null}
    }

    const cursorList = (q: AddressListQuery): Promise<AddressRow[]> =>
      runIDB('readonly', async (store) => {
        const {indexName, range} = pickRange(q)
        const source: IDBIndex | IDBObjectStore = indexName === '' ? store : store.index(indexName)
        const cursorReq = range === null ? source.openCursor() : source.openCursor(range)
        const results: AddressRow[] = []
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
        return sortRows(results)
      })

    const list: AddressTable['list'] = (q) =>
      Effect.gen(function* () {
        yield* checkClosed
        return yield* Effect.tryPromise({
          try: () => cursorList(q),
          catch: (e) => new StoreError({message: `Failed to list address rows: ${e}`, cause: e}),
        })
      })

    const get: AddressTable['get'] = (ref, branch, index) =>
      Effect.gen(function* () {
        yield* checkClosed
        const row = yield* Effect.tryPromise({
          try: () =>
            runIDB('readonly', async (store) =>
              awaitRequest(store.get([ref.groupId, ref.chainId, ref.accountIndex, branch, index])),
            ),
          catch: (e) => new StoreError({message: `Failed to get address row: ${e}`, cause: e}),
        })
        if (row === undefined) return null
        return fromStored(row as StoredRow)
      })

    const count: AddressTable['count'] = (q) =>
      Effect.gen(function* () {
        yield* checkClosed
        // For ranges that map cleanly to an index we use a counted cursor;
        // otherwise we fall back to a full scan (acceptable — count is not
        // a hot path).
        return yield* Effect.tryPromise({
          try: () => cursorList(q).then((rows) => rows.length),
          catch: (e) => new StoreError({message: `Failed to count address rows: ${e}`, cause: e}),
        })
      })

    const clear: AddressTable['clear'] = (ref) =>
      Effect.gen(function* () {
        yield* checkClosed
        yield* Effect.tryPromise({
          try: () =>
            runIDB('readwrite', async (store) => {
              const idx = store.index('byPartitionBranchUsed')
              const lower = [ref.groupId, ref.chainId, ref.accountIndex, ' ', 0]
              const upper = [ref.groupId, ref.chainId, ref.accountIndex, '￿', 1]
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
          catch: (e) => new StoreError({message: `Failed to clear address rows: ${e}`, cause: e}),
        })
      })

    const close: AddressTable['close'] = () =>
      Effect.gen(function* () {
        const wasClosed = yield* Ref.get(closedRef)
        if (wasClosed) return
        yield* Ref.set(closedRef, true)
        db.close()
      })

    const table: AddressTable = {upsert, upsertMany, list, get, count, clear, close}
    return table
  })
