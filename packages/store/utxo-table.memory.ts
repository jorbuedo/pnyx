/**
 * In-process implementation of {@link UtxoTable} for tests.
 *
 * Backed by a plain `Map<rowKey, UtxoRow>` — no SQL, no async. Mirrors the
 * production adapters' visible behavior (partition filter / `pureOnly` /
 * upsert / atomic replaceAll) but with O(N) scans; performance is not
 * representative.
 *
 * @module
 */

import {Effect, Ref} from 'effect'
import {StoreClosedError} from './errors.js'
import type {UtxoListQuery, UtxoRef, UtxoRow, UtxoTable} from './utxo-table.js'

const rowKey = (ref: UtxoRef, txHash: string, txIndex: number): string =>
  `${ref.groupId}:${ref.chainId}:${ref.accountIndex}:${txHash}#${txIndex}`

const refMatches = (row: UtxoRow, ref: UtxoRef): boolean =>
  row.groupId === ref.groupId && row.chainId === ref.chainId && row.accountIndex === ref.accountIndex

const passesFilters = (row: UtxoRow, q: UtxoListQuery): boolean => {
  if (!refMatches(row, q)) return false
  if (q.pureOnly === true && row.assets.length > 0) return false
  return true
}

/**
 * Create an in-memory {@link UtxoTable} for use in tests.
 */
export const MemoryUtxoTable: Effect.Effect<UtxoTable> = Effect.gen(function* () {
  const data = yield* Ref.make<Map<string, UtxoRow>>(new Map())
  const closed = yield* Ref.make(false)

  const checkClosed = Effect.gen(function* () {
    if (yield* Ref.get(closed)) {
      return yield* Effect.fail(new StoreClosedError({message: 'UtxoTable is closed'}))
    }
  })

  const put: UtxoTable['put'] = (row) =>
    Effect.gen(function* () {
      yield* checkClosed
      yield* Ref.update(data, (m) => {
        const next = new Map(m)
        next.set(rowKey(row, row.txHash, row.txIndex), row)
        return next
      })
    })

  const putMany: UtxoTable['putMany'] = (rows) =>
    Effect.gen(function* () {
      yield* checkClosed
      yield* Ref.update(data, (m) => {
        const next = new Map(m)
        for (const r of rows) next.set(rowKey(r, r.txHash, r.txIndex), r)
        return next
      })
    })

  const deleteRows: UtxoTable['delete'] = (ref, keys) =>
    Effect.gen(function* () {
      yield* checkClosed
      yield* Ref.update(data, (m) => {
        const next = new Map(m)
        for (const k of keys) next.delete(rowKey(ref, k.txHash, k.txIndex))
        return next
      })
    })

  const replaceAll: UtxoTable['replaceAll'] = (ref, rows) =>
    Effect.gen(function* () {
      yield* checkClosed
      yield* Ref.update(data, (m) => {
        const next = new Map(m)
        for (const [k, r] of m) {
          if (refMatches(r, ref)) next.delete(k)
        }
        for (const r of rows) next.set(rowKey(r, r.txHash, r.txIndex), r)
        return next
      })
    })

  const list: UtxoTable['list'] = (q) =>
    Effect.gen(function* () {
      yield* checkClosed
      const m = yield* Ref.get(data)
      const result: UtxoRow[] = []
      for (const r of m.values()) {
        if (passesFilters(r, q)) result.push(r)
      }
      return result
    })

  const count: UtxoTable['count'] = (ref) =>
    Effect.gen(function* () {
      yield* checkClosed
      const m = yield* Ref.get(data)
      let n = 0
      for (const r of m.values()) {
        if (refMatches(r, ref)) n += 1
      }
      return n
    })

  const clear: UtxoTable['clear'] = (ref) =>
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

  const close: UtxoTable['close'] = () =>
    Effect.gen(function* () {
      yield* Ref.set(closed, true)
    })

  const table: UtxoTable = {put, putMany, delete: deleteRows, replaceAll, list, count, clear, close}
  return table
})
