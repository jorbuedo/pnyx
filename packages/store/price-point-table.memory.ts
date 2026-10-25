/**
 * In-process implementation of {@link PricePointTable} for tests.
 *
 * Backed by a `Map<"network:seriesKey:tsBucket", PricePointRow>`.
 *
 * @module
 */

import {Effect, Ref} from 'effect'
import {StoreClosedError} from './errors.js'
import type {PricePointRow, PricePointTable} from './price-point-table.js'

const key = (network: string, seriesKey: string, tsBucket: number): string => `${network}:${seriesKey}:${tsBucket}`

export const MemoryPricePointTable: Effect.Effect<PricePointTable> = Effect.gen(function* () {
  const data = yield* Ref.make<Map<string, PricePointRow>>(new Map())
  const closed = yield* Ref.make(false)

  const checkClosed = Effect.gen(function* () {
    if (yield* Ref.get(closed)) {
      return yield* Effect.fail(new StoreClosedError({message: 'PricePointTable is closed'}))
    }
  })

  const putMany: PricePointTable['putMany'] = (rows) =>
    Effect.gen(function* () {
      yield* checkClosed
      yield* Ref.update(data, (m) => {
        const next = new Map(m)
        for (const r of rows) next.set(key(r.network, r.seriesKey, r.tsBucket), r)
        return next
      })
    })

  const getRange: PricePointTable['getRange'] = (network, seriesKey, fromTsBucket, toTsBucket) =>
    Effect.gen(function* () {
      yield* checkClosed
      const m = yield* Ref.get(data)
      const out: PricePointRow[] = []
      for (const r of m.values()) {
        if (
          r.network === network &&
          r.seriesKey === seriesKey &&
          r.tsBucket >= fromTsBucket &&
          r.tsBucket <= toTsBucket
        )
          out.push(r)
      }
      return out.sort((a, b) => a.tsBucket - b.tsBucket)
    })

  const prune: PricePointTable['prune'] = (network, seriesKey, beforeTsBucket) =>
    Effect.gen(function* () {
      yield* checkClosed
      yield* Ref.update(data, (m) => {
        const next = new Map(m)
        for (const [k, r] of m) {
          if (r.network === network && r.seriesKey === seriesKey && r.tsBucket < beforeTsBucket) next.delete(k)
        }
        return next
      })
    })

  const clear: PricePointTable['clear'] = (network) =>
    Effect.gen(function* () {
      yield* checkClosed
      yield* Ref.update(data, (m) => {
        const next = new Map(m)
        for (const [k, r] of m) {
          if (r.network === network) next.delete(k)
        }
        return next
      })
    })

  const close: PricePointTable['close'] = () =>
    Effect.gen(function* () {
      yield* Ref.set(closed, true)
    })

  const table: PricePointTable = {putMany, getRange, prune, clear, close}
  return table
})
