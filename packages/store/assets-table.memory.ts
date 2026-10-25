/**
 * In-process implementation of {@link AssetsTable} for tests.
 *
 * Backed by a plain `Map<rowKey, AssetRow>` — no SQL, no async. Mirrors the
 * production adapters' visible behavior (partition filter / usdValue-desc sort
 * / paging / atomic replaceAll) with O(N) scans; performance is not
 * representative.
 *
 * @module
 */

import {Effect, Ref} from 'effect'
import type {AssetListQuery, AssetRef, AssetRow, AssetsTable} from './assets-table.js'
import {StoreClosedError} from './errors.js'

const rowKey = (ref: AssetRef, id: string): string => `${ref.groupId}:${ref.chainId}:${ref.accountIndex}:${id}`

const refMatches = (row: AssetRow, ref: AssetRef): boolean =>
  row.groupId === ref.groupId && row.chainId === ref.chainId && row.accountIndex === ref.accountIndex

/** Create an in-memory {@link AssetsTable} for use in tests. */
export const MemoryAssetsTable: Effect.Effect<AssetsTable> = Effect.gen(function* () {
  const data = yield* Ref.make<Map<string, AssetRow>>(new Map())
  const closed = yield* Ref.make(false)

  const checkClosed = Effect.gen(function* () {
    if (yield* Ref.get(closed)) {
      return yield* Effect.fail(new StoreClosedError({message: 'AssetsTable is closed'}))
    }
  })

  const replaceAll: AssetsTable['replaceAll'] = (ref, rows) =>
    Effect.gen(function* () {
      yield* checkClosed
      yield* Ref.update(data, (m) => {
        const next = new Map(m)
        for (const [k, r] of m) {
          if (refMatches(r, ref)) next.delete(k)
        }
        for (const r of rows) next.set(rowKey(r, r.id), r)
        return next
      })
    })

  const list: AssetsTable['list'] = (q: AssetListQuery) =>
    Effect.gen(function* () {
      yield* checkClosed
      const m = yield* Ref.get(data)
      const result: AssetRow[] = []
      for (const r of m.values()) {
        if (refMatches(r, q)) result.push(r)
      }
      result.sort((a, b) => b.usdValue - a.usdValue)
      const start = q.offset ?? 0
      return q.limit != null ? result.slice(start, start + q.limit) : result.slice(start)
    })

  const count: AssetsTable['count'] = (ref) =>
    Effect.gen(function* () {
      yield* checkClosed
      const m = yield* Ref.get(data)
      let n = 0
      for (const r of m.values()) {
        if (refMatches(r, ref)) n += 1
      }
      return n
    })

  const clear: AssetsTable['clear'] = (ref) =>
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

  const close: AssetsTable['close'] = () =>
    Effect.gen(function* () {
      yield* Ref.set(closed, true)
    })

  const table: AssetsTable = {replaceAll, list, count, clear, close}
  return table
})
