/**
 * In-process implementation of {@link TokenMetadataTable} for tests.
 *
 * Backed by a `Map<"network:tokenId", TokenMetadataRow>` — no SQL, no async.
 *
 * @module
 */

import {Effect, Ref} from 'effect'
import {StoreClosedError} from './errors.js'
import type {TokenMetadataRow, TokenMetadataTable} from './token-metadata-table.js'

const key = (network: string, tokenId: string): string => `${network}:${tokenId}`

export const MemoryTokenMetadataTable: Effect.Effect<TokenMetadataTable> = Effect.gen(function* () {
  const data = yield* Ref.make<Map<string, TokenMetadataRow>>(new Map())
  const closed = yield* Ref.make(false)

  const checkClosed = Effect.gen(function* () {
    if (yield* Ref.get(closed)) {
      return yield* Effect.fail(new StoreClosedError({message: 'TokenMetadataTable is closed'}))
    }
  })

  const putMany: TokenMetadataTable['putMany'] = (rows) =>
    Effect.gen(function* () {
      yield* checkClosed
      yield* Ref.update(data, (m) => {
        const next = new Map(m)
        for (const r of rows) next.set(key(r.network, r.tokenId), r)
        return next
      })
    })

  const getMany: TokenMetadataTable['getMany'] = (network, tokenIds) =>
    Effect.gen(function* () {
      yield* checkClosed
      const m = yield* Ref.get(data)
      const result: TokenMetadataRow[] = []
      for (const id of tokenIds) {
        const row = m.get(key(network, id))
        if (row) result.push(row)
      }
      return result
    })

  const clear: TokenMetadataTable['clear'] = (network) =>
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

  const close: TokenMetadataTable['close'] = () =>
    Effect.gen(function* () {
      yield* Ref.set(closed, true)
    })

  const table: TokenMetadataTable = {putMany, getMany, clear, close}
  return table
})
