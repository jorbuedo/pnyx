import {Effect} from 'effect'
import {beforeEach, describe, expect, it} from 'vitest'
import type {TokenPriceRow, TokenPricesTable} from './token-prices-table.js'
import {MemoryTokenPricesTable} from './token-prices-table.memory.js'

const row = (overrides: Partial<TokenPriceRow> = {}): TokenPriceRow => ({
  network: 'mainnet',
  cacheKey: 'spot:p1.n1',
  value: 1.5,
  fetchedAt: 1000,
  ...overrides,
})

const run = <E, A>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect as Effect.Effect<A, never>)

describe('MemoryTokenPricesTable', () => {
  let table: TokenPricesTable

  beforeEach(async () => {
    table = await run(MemoryTokenPricesTable)
  })

  it('round-trips by (network, cacheKey)', async () => {
    await run(table.putMany([row({cacheKey: 'a'}), row({cacheKey: 'b'})]))
    const got = await run(table.getMany('mainnet', ['a', 'b']))
    expect(got.map((r) => r.cacheKey).sort()).toEqual(['a', 'b'])
  })

  it('getMany returns only requested keys (caller diffs for misses)', async () => {
    await run(table.putMany([row({cacheKey: 'a'})]))
    const got = await run(table.getMany('mainnet', ['a', 'missing']))
    expect(got.map((r) => r.cacheKey)).toEqual(['a'])
  })

  it('is global — same cacheKey is shared, not per-wallet', async () => {
    await run(table.putMany([row({cacheKey: 'shared', value: 42})]))
    // Any wallet asking for the same key gets the one cached entry.
    expect((await run(table.getMany('mainnet', ['shared'])))[0]?.value).toBe(42)
  })

  it('partitions by network', async () => {
    await run(table.putMany([row({network: 'mainnet', cacheKey: 'a'}), row({network: 'testnet', cacheKey: 'a'})]))
    expect(await run(table.getMany('mainnet', ['a']))).toHaveLength(1)
    await run(table.clear('mainnet'))
    expect(await run(table.getMany('mainnet', ['a']))).toHaveLength(0)
    expect(await run(table.getMany('testnet', ['a']))).toHaveLength(1)
  })

  it('upserts by key', async () => {
    await run(table.putMany([row({cacheKey: 'a', value: 1, fetchedAt: 1})]))
    await run(table.putMany([row({cacheKey: 'a', value: 2, fetchedAt: 2})]))
    const got = await run(table.getMany('mainnet', ['a']))
    expect(got).toHaveLength(1)
    expect(got[0]?.value).toBe(2)
    expect(got[0]?.fetchedAt).toBe(2)
  })
})
