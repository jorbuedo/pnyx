/**
 * IndexedDB implementation of {@link TxTable} for web / extension.
 *
 * Backed by a dedicated database (default `pnyx-tx`) with a single
 * `transactions` object store keyed by the composite
 * `[groupId, chainId, accountIndex, hash]` tuple. A `bySortKey` index
 * supports `ORDER BY timestamp DESC NULLS FIRST` semantics via a derived
 * sort key (pending rows without a timestamp pin to the top).
 *
 * Schema versioning piggybacks on IndexedDB's built-in database version
 * mechanism — bumping {@link TX_TABLE_SCHEMA_VERSION} triggers
 * `onupgradeneeded` on next open, which drops and recreates the store.
 * Chain-sync repopulates on next mount.
 *
 * @module
 */

import {Effect, Ref} from 'effect'
import {StoreClosedError, StoreError, type StoreErrors} from './errors.js'
import {withIndexedDbOpenRetry} from './idb-open.js'
import {
  TX_TABLE_SCHEMA_VERSION,
  type TxListItem,
  type TxListQuery,
  type TxRef,
  type TxRow,
  type TxTable,
} from './tx-table.js'

const STORE_NAME = 'transactions'

/**
 * Sort-key sentinel for null timestamps.
 *
 * IndexedDB indexes silently skip rows where the indexed property is
 * `null` — they'd never appear in cursor iteration. To keep pending
 * rows visible (and pinned to the top in descending order, matching
 * the documented contract), we materialise a `_sortKey = timestamp ??
 * MAX_SAFE_INTEGER` on every stored row and index on that.
 *
 * The `_sortKey` field is an implementation detail of this adapter —
 * `TxRow` consumers never see it.
 */
const NULL_TIMESTAMP_SORT_KEY = Number.MAX_SAFE_INTEGER

/**
 * Internal stored shape — extends TxRow with the derived sort key.
 */
type StoredRow = TxRow & {readonly _sortKey: number}

const toStored = (row: TxRow): StoredRow => ({
  ...row,
  _sortKey: row.timestamp ?? NULL_TIMESTAMP_SORT_KEY,
})

const fromStored = (row: StoredRow): TxRow => {
  const {_sortKey: _ignored, ...rest} = row
  return rest
}

const stripDetail = (row: TxRow): TxListItem => {
  const {detailJson: _ignored, ...rest} = row
  return rest
}

const refMatches = (row: TxRow, ref: TxRef): boolean =>
  row.groupId === ref.groupId && row.chainId === ref.chainId && row.accountIndex === ref.accountIndex

const passesFilters = (row: TxRow, q: TxListQuery): boolean => {
  if (q.status !== undefined && row.status !== q.status) return false
  if (q.types !== undefined && !q.types.includes(row.type)) return false
  if (q.newerThan !== undefined && (row.timestamp === null || row.timestamp <= q.newerThan)) return false
  if (q.olderThan !== undefined && (row.timestamp === null || row.timestamp >= q.olderThan)) return false
  return true
}

/**
 * Open the transactions table on the given IndexedDB database.
 *
 * Defaults to `pnyx-tx` — a dedicated database name so schema
 * bumps drop our store cleanly without touching the KV store's DB.
 */
export const IndexedDBTxTable = (dbName = 'pnyx-tx'): Effect.Effect<TxTable, StoreError> =>
  Effect.gen(function* () {
    const db = yield* withIndexedDbOpenRetry(
      Effect.tryPromise({
        try: () =>
          new Promise<IDBDatabase>((resolve, reject) => {
            // IndexedDB's own database version doubles as our schema version.
            // Bumping TX_TABLE_SCHEMA_VERSION triggers onupgradeneeded, which
            // drops and recreates the store — chain-sync repopulates on
            // next mount. Wipe-and-resync model; no migration framework.
            const request = indexedDB.open(dbName, TX_TABLE_SCHEMA_VERSION)
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
              reject(new Error('tx-table IndexedDB open blocked by another connection'))
            }
            request.onupgradeneeded = () => {
              const upgrading = request.result
              // Drop any prior version of the store and start fresh. This is
              // the "wipe transactions on schema bump" path — snapshots and
              // checkpoints live in a different database so they're untouched.
              if (upgrading.objectStoreNames.contains(STORE_NAME)) {
                upgrading.deleteObjectStore(STORE_NAME)
              }
              // Composite primary key on (group, chain, account, hash) gives
              // natural upsert semantics and a fast partition scan.
              const store = upgrading.createObjectStore(STORE_NAME, {
                keyPath: ['groupId', 'chainId', 'accountIndex', 'hash'],
              })
              // Workhorse index for the list query — sorts by `_sortKey`
              // (timestamp with null pinned to MAX_SAFE_INTEGER) within
              // each (group, chain, account) partition.
              store.createIndex('bySortKey', ['groupId', 'chainId', 'accountIndex', '_sortKey'], {unique: false})
            }
          }),
        catch: (e) => new StoreError({message: `Failed to open tx-table IndexedDB: ${e}`, cause: e}),
      }),
    )

    const closedRef = yield* Ref.make(false)

    const checkClosed: Effect.Effect<void, StoreErrors> = Effect.gen(function* () {
      if (yield* Ref.get(closedRef)) {
        return yield* Effect.fail(new StoreClosedError({message: 'TxTable is closed'}))
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

    const put: TxTable['put'] = (row) =>
      Effect.gen(function* () {
        yield* checkClosed
        yield* Effect.tryPromise({
          try: () => runIDB('readwrite', (store) => awaitRequest(store.put(toStored(row)))),
          catch: (e) => new StoreError({message: `Failed to put tx row: ${e}`, cause: e}),
        })
      })

    const putMany: TxTable['putMany'] = (rows) =>
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
          catch: (e) => new StoreError({message: `Failed to put tx rows: ${e}`, cause: e}),
        })
      })

    /**
     * Iterate the `bySortKey` index in descending order over the
     * (group, chain, account) partition. Apply JS-level filters /
     * offset / limit during iteration so we never materialise more
     * rows than necessary.
     */
    const listInternal = (q: TxListQuery): Promise<TxRow[]> =>
      runIDB('readonly', async (store) => {
        const idx = store.index('bySortKey')
        // Key range is exactly the (group, chain, account) partition —
        // anything from sortKey=-∞ to sortKey=+∞.
        const lower = [q.groupId, q.chainId, q.accountIndex, -Infinity]
        const upper = [q.groupId, q.chainId, q.accountIndex, +Infinity]
        const range = IDBKeyRange.bound(lower, upper)
        const results: TxRow[] = []
        const offset = q.offset ?? 0
        const limit = q.limit ?? Number.POSITIVE_INFINITY
        let skipped = 0
        const cursorReq = idx.openCursor(range, 'prev')
        await new Promise<void>((resolve, reject) => {
          cursorReq.onsuccess = () => {
            const cursor = cursorReq.result
            if (!cursor || results.length >= limit) {
              resolve()
              return
            }
            const stored = cursor.value as StoredRow
            const row = fromStored(stored)
            if (passesFilters(row, q)) {
              if (skipped < offset) {
                skipped += 1
              } else {
                results.push(row)
              }
            }
            cursor.continue()
          }
          cursorReq.onerror = () => reject(cursorReq.error)
        })
        return results
      })

    const list: TxTable['list'] = (q) =>
      Effect.gen(function* () {
        yield* checkClosed
        const rows = yield* Effect.tryPromise({
          try: () => listInternal(q),
          catch: (e) => new StoreError({message: `Failed to list tx rows: ${e}`, cause: e}),
        })
        return rows.map(stripDetail)
      })

    const get: TxTable['get'] = (ref, hash) =>
      Effect.gen(function* () {
        yield* checkClosed
        const stored = yield* Effect.tryPromise({
          try: () =>
            runIDB('readonly', (store) =>
              awaitRequest(store.get([ref.groupId, ref.chainId, ref.accountIndex, hash]) as IDBRequest<StoredRow>),
            ),
          catch: (e) => new StoreError({message: `Failed to get tx row: ${e}`, cause: e}),
        })
        return stored ? fromStored(stored) : null
      })

    const prune: TxTable['prune'] = (ref, keepCount) =>
      Effect.gen(function* () {
        yield* checkClosed
        // Collect all hashes for the partition in newest-first order,
        // skip the first `keepCount`, delete the rest in a single
        // readwrite transaction.
        const deleted = yield* Effect.tryPromise({
          try: () =>
            runIDB('readwrite', async (store) => {
              const idx = store.index('bySortKey')
              const lower = [ref.groupId, ref.chainId, ref.accountIndex, -Infinity]
              const upper = [ref.groupId, ref.chainId, ref.accountIndex, +Infinity]
              const range = IDBKeyRange.bound(lower, upper)
              const cursorReq = idx.openCursor(range, 'prev')
              let seen = 0
              let removed = 0
              await new Promise<void>((resolve, reject) => {
                cursorReq.onsuccess = () => {
                  const cursor = cursorReq.result
                  if (!cursor) {
                    resolve()
                    return
                  }
                  if (seen < keepCount) {
                    seen += 1
                  } else {
                    cursor.delete()
                    removed += 1
                  }
                  cursor.continue()
                }
                cursorReq.onerror = () => reject(cursorReq.error)
              })
              return removed
            }),
          catch: (e) => new StoreError({message: `Failed to prune tx rows: ${e}`, cause: e}),
        })
        return deleted
      })

    const clear: TxTable['clear'] = (ref) =>
      Effect.gen(function* () {
        yield* checkClosed
        yield* Effect.tryPromise({
          try: () =>
            runIDB('readwrite', async (store) => {
              const idx = store.index('bySortKey')
              const lower = [ref.groupId, ref.chainId, ref.accountIndex, -Infinity]
              const upper = [ref.groupId, ref.chainId, ref.accountIndex, +Infinity]
              const range = IDBKeyRange.bound(lower, upper)
              const cursorReq = idx.openCursor(range)
              await new Promise<void>((resolve, reject) => {
                cursorReq.onsuccess = () => {
                  const cursor = cursorReq.result
                  if (!cursor) {
                    resolve()
                    return
                  }
                  // Sanity check — refMatches guards against any
                  // partition leak in the index lookup, though the
                  // range should already scope cleanly.
                  if (refMatches(cursor.value as StoredRow, ref)) {
                    cursor.delete()
                  }
                  cursor.continue()
                }
                cursorReq.onerror = () => reject(cursorReq.error)
              })
            }),
          catch: (e) => new StoreError({message: `Failed to clear tx rows: ${e}`, cause: e}),
        })
      })

    const close: TxTable['close'] = () =>
      Effect.gen(function* () {
        const wasClosed = yield* Ref.get(closedRef)
        if (wasClosed) return
        yield* Ref.set(closedRef, true)
        db.close()
      })

    const table: TxTable = {put, putMany, list, get, prune, clear, close}
    return table
  })
