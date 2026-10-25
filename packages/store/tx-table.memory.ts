/**
 * In-process implementation of {@link TxTable} for tests.
 *
 * Backed by a plain `Map<rowKey, TxRow>` — no SQL, no async — so test
 * suites don't need an SQLite or IndexedDB shim. Mirrors the production
 * adapters' visible behavior (filter / sort / projection / prune) but
 * with O(N) scans for each query; performance characteristics are not
 * representative.
 *
 * Not exported from the package root by default — tests import directly
 * from `@pnyx/store/tx-table.memory`.
 *
 * @module
 */

import {Effect, Ref} from 'effect'
import {StoreClosedError, type StoreErrors} from './errors.js'
import type {TxListItem, TxListQuery, TxRef, TxRow, TxTable} from './tx-table.js'

const rowKey = (ref: TxRef, hash: string): string => `${ref.groupId}:${ref.chainId}:${ref.accountIndex}:${hash}`

const refMatches = (row: TxRow, ref: TxRef): boolean =>
  row.groupId === ref.groupId && row.chainId === ref.chainId && row.accountIndex === ref.accountIndex

const stripDetail = (row: TxRow): TxListItem => {
  const {detailJson: _detailJson, ...rest} = row
  return rest
}

/**
 * Sort rows newest-first. Rows with `timestamp: null` (pending without a
 * known submit time) sort to the very top, matching the SQL adapters'
 * `ORDER BY timestamp DESC NULLS FIRST` semantics.
 */
const compareByTimestampDesc = (a: TxRow, b: TxRow): number => {
  if (a.timestamp === null && b.timestamp === null) return 0
  if (a.timestamp === null) return -1
  if (b.timestamp === null) return 1
  return b.timestamp - a.timestamp
}

const applyFilters = (rows: ReadonlyArray<TxRow>, q: TxListQuery): TxRow[] => {
  const filtered = rows.filter((r) => {
    if (!refMatches(r, q)) return false
    if (q.status !== undefined && r.status !== q.status) return false
    if (q.types !== undefined && !q.types.includes(r.type)) return false
    if (q.newerThan !== undefined && (r.timestamp === null || r.timestamp <= q.newerThan)) return false
    if (q.olderThan !== undefined && (r.timestamp === null || r.timestamp >= q.olderThan)) return false
    return true
  })
  filtered.sort(compareByTimestampDesc)
  const start = q.offset ?? 0
  const end = q.limit !== undefined ? start + q.limit : filtered.length
  return filtered.slice(start, end)
}

/**
 * Create an in-memory {@link TxTable} for use in tests.
 *
 * Returned as an `Effect` so callers can compose with the rest of the
 * Effect-TS test setup.
 */
export const MemoryTxTable: Effect.Effect<TxTable> = Effect.gen(function* () {
  const data = yield* Ref.make<Map<string, TxRow>>(new Map())
  const closed = yield* Ref.make(false)

  const checkClosed = Effect.gen(function* () {
    if (yield* Ref.get(closed)) {
      return yield* Effect.fail(new StoreClosedError({message: 'TxTable is closed'}))
    }
  })

  const put = (row: TxRow): Effect.Effect<void, StoreErrors> =>
    Effect.gen(function* () {
      yield* checkClosed
      yield* Ref.update(data, (m) => {
        const next = new Map(m)
        next.set(rowKey(row, row.hash), row)
        return next
      })
    })

  const putMany = (rows: ReadonlyArray<TxRow>): Effect.Effect<void, StoreErrors> =>
    Effect.gen(function* () {
      yield* checkClosed
      yield* Ref.update(data, (m) => {
        const next = new Map(m)
        for (const r of rows) next.set(rowKey(r, r.hash), r)
        return next
      })
    })

  const list = (q: TxListQuery): Effect.Effect<ReadonlyArray<TxListItem>, StoreErrors> =>
    Effect.gen(function* () {
      yield* checkClosed
      const m = yield* Ref.get(data)
      const rows = applyFilters([...m.values()], q)
      return rows.map(stripDetail)
    })

  const get = (ref: TxRef, hash: string): Effect.Effect<TxRow | null, StoreErrors> =>
    Effect.gen(function* () {
      yield* checkClosed
      const m = yield* Ref.get(data)
      return m.get(rowKey(ref, hash)) ?? null
    })

  const prune = (ref: TxRef, keepCount: number): Effect.Effect<number, StoreErrors> =>
    Effect.gen(function* () {
      yield* checkClosed
      const m = yield* Ref.get(data)
      const matching = [...m.values()].filter((r) => refMatches(r, ref))
      if (matching.length <= keepCount) return 0
      matching.sort(compareByTimestampDesc)
      const toDelete = matching.slice(keepCount)
      yield* Ref.update(data, (curr) => {
        const next = new Map(curr)
        for (const r of toDelete) next.delete(rowKey(r, r.hash))
        return next
      })
      return toDelete.length
    })

  const clear = (ref: TxRef): Effect.Effect<void, StoreErrors> =>
    Effect.gen(function* () {
      yield* checkClosed
      yield* Ref.update(data, (curr) => {
        const next = new Map(curr)
        for (const [k, r] of curr) {
          if (refMatches(r, ref)) next.delete(k)
        }
        return next
      })
    })

  const close = (): Effect.Effect<void, StoreErrors> =>
    Effect.gen(function* () {
      yield* Ref.set(closed, true)
    })

  const table: TxTable = {put, putMany, list, get, prune, clear, close}
  return table
})
