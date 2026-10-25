/**
 * In-process implementation of {@link AddressTable} for tests.
 *
 * Backed by a plain `Map<rowKey, AddressRow>` — no SQL, no async. Mirrors
 * the production adapters' visible behavior (partition filter / branch /
 * isUsed filter / upsert) but with O(N) scans; performance is not
 * representative.
 *
 * @module
 */

import {Effect, Ref} from 'effect'
import type {AddressBranch, AddressListQuery, AddressRef, AddressRow, AddressTable} from './address-table.js'
import {StoreClosedError} from './errors.js'

const rowKey = (ref: AddressRef, branch: AddressBranch, index: number): string =>
  `${ref.groupId}:${ref.chainId}:${ref.accountIndex}:${branch}#${index}`

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

/**
 * Create an in-memory {@link AddressTable} for use in tests.
 */
export const MemoryAddressTable: Effect.Effect<AddressTable> = Effect.gen(function* () {
  const data = yield* Ref.make<Map<string, AddressRow>>(new Map())
  const closed = yield* Ref.make(false)

  const checkClosed = Effect.gen(function* () {
    if (yield* Ref.get(closed)) {
      return yield* Effect.fail(new StoreClosedError({message: 'AddressTable is closed'}))
    }
  })

  const upsert: AddressTable['upsert'] = (row) =>
    Effect.gen(function* () {
      yield* checkClosed
      yield* Ref.update(data, (m) => {
        const next = new Map(m)
        next.set(rowKey(row, row.branch, row.index), row)
        return next
      })
    })

  const upsertMany: AddressTable['upsertMany'] = (rows) =>
    Effect.gen(function* () {
      yield* checkClosed
      yield* Ref.update(data, (m) => {
        const next = new Map(m)
        for (const r of rows) next.set(rowKey(r, r.branch, r.index), r)
        return next
      })
    })

  const list: AddressTable['list'] = (q) =>
    Effect.gen(function* () {
      yield* checkClosed
      const m = yield* Ref.get(data)
      const result: AddressRow[] = []
      for (const r of m.values()) {
        if (passesFilters(r, q)) result.push(r)
      }
      // Canonical order — mirror the production adapters' (branch, index) sort.
      result.sort((a, b) => {
        if (a.groupId !== b.groupId) return a.groupId.localeCompare(b.groupId)
        if (a.chainId !== b.chainId) return a.chainId.localeCompare(b.chainId)
        if (a.accountIndex !== b.accountIndex) return a.accountIndex - b.accountIndex
        if (a.branch !== b.branch) return a.branch.localeCompare(b.branch)
        return a.index - b.index
      })
      return result
    })

  const get: AddressTable['get'] = (ref, branch, index) =>
    Effect.gen(function* () {
      yield* checkClosed
      const m = yield* Ref.get(data)
      return m.get(rowKey(ref, branch, index)) ?? null
    })

  const count: AddressTable['count'] = (q) =>
    Effect.gen(function* () {
      yield* checkClosed
      const m = yield* Ref.get(data)
      let n = 0
      for (const r of m.values()) {
        if (passesFilters(r, q)) n += 1
      }
      return n
    })

  const clear: AddressTable['clear'] = (ref) =>
    Effect.gen(function* () {
      yield* checkClosed
      yield* Ref.update(data, (m) => {
        const next = new Map(m)
        for (const [k, r] of m) {
          if (refMatches(r, ref)) next.delete(k)
        }
        return next
      })
    })

  const close: AddressTable['close'] = () =>
    Effect.gen(function* () {
      yield* Ref.set(closed, true)
    })

  const table: AddressTable = {upsert, upsertMany, list, get, count, clear, close}
  return table
})
