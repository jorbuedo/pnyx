/**
 * In-process implementation of {@link TokenPricesTable} for tests.
 *
 * Backed by a `Map<"network:cacheKey", TokenPriceRow>` — no SQL, no async.
 *
 * @module
 */

import {Effect, Ref} from 'effect'
import {StoreClosedError} from './errors.js'
import type {TokenPriceRow, TokenPricesTable} from './token-prices-table.js'

const key = (network: string, cacheKey: string): string => `${network}:${cacheKey}`

export const MemoryTokenPricesTable: Effect.Effect<TokenPricesTable> = Effect.gen(function* () {
  const data = yield* Ref.make<Map<string, TokenPriceRow>>(new Map())
  const closed = yield* Ref.make(false)

  const checkClosed = Effect.gen(function* () {
    if (yield* Ref.get(closed)) {
      return yield* Effect.fail(new StoreClosedError({message: 'TokenPricesTable is closed'}))
    }
  })

  const putMany: TokenPricesTable['putMany'] = (rows) =>
    Effect.gen(function* () {
      yield* checkClosed
      yield* Ref.update(data, (m) => {
        const next = new Map(m)
        for (const r of rows) next.set(key(r.network, r.cacheKey), r)
        return next
      })
    })

  const getMany: TokenPricesTable['getMany'] = (network, cacheKeys) =>
    Effect.gen(function* () {
      yield* checkClosed
      const m = yield* Ref.get(data)
      const result: TokenPriceRow[] = []
      for (const cacheKey of cacheKeys) {
        const row = m.get(key(network, cacheKey))
        if (row) result.push(row)
      }
      return result
    })

  const clear: TokenPricesTable['clear'] = (network) =>
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

  const close: TokenPricesTable['close'] = () =>
    Effect.gen(function* () {
      yield* Ref.set(closed, true)
    })

  const table: TokenPricesTable = {putMany, getMany, clear, close}
  return table
})
