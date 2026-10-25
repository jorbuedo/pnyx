import {Effect} from 'effect'
import {beforeEach, describe, expect, it} from 'vitest'
import type {TokenMetadataRow, TokenMetadataTable} from './token-metadata-table.js'
import {MemoryTokenMetadataTable} from './token-metadata-table.memory.js'

const row = (overrides: Partial<TokenMetadataRow> = {}): TokenMetadataRow => ({
  network: 'mainnet',
  tokenId: 'p1.n1',
  detailJson: '{"decimals":6,"ticker":"FOO"}',
  fetchedAt: 1000,
  ...overrides,
})

const run = <E, A>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect as Effect.Effect<A, never>)

describe('MemoryTokenMetadataTable', () => {
  let table: TokenMetadataTable

  beforeEach(async () => {
    table = await run(MemoryTokenMetadataTable)
  })

  it('round-trips by (network, tokenId)', async () => {
    await run(table.putMany([row({tokenId: 'a'}), row({tokenId: 'b'})]))
    const got = await run(table.getMany('mainnet', ['a', 'b']))
    expect(got.map((r) => r.tokenId).sort()).toEqual(['a', 'b'])
  })

  it('getMany returns only requested ids (caller diffs for misses)', async () => {
    await run(table.putMany([row({tokenId: 'a'})]))
    const got = await run(table.getMany('mainnet', ['a', 'missing']))
    expect(got.map((r) => r.tokenId)).toEqual(['a'])
  })

  it('is global — same tokenId is shared, not per-wallet', async () => {
    await run(table.putMany([row({tokenId: 'shared', detailJson: '{"v":1}'})]))
    // Any wallet asking for the same id gets the one cached entry.
    expect((await run(table.getMany('mainnet', ['shared'])))[0]?.detailJson).toBe('{"v":1}')
  })

  it('partitions by network', async () => {
    await run(table.putMany([row({network: 'mainnet', tokenId: 'a'}), row({network: 'testnet', tokenId: 'a'})]))
    expect(await run(table.getMany('mainnet', ['a']))).toHaveLength(1)
    await run(table.clear('mainnet'))
    expect(await run(table.getMany('mainnet', ['a']))).toHaveLength(0)
    expect(await run(table.getMany('testnet', ['a']))).toHaveLength(1)
  })

  it('upserts by key', async () => {
    await run(table.putMany([row({tokenId: 'a', fetchedAt: 1})]))
    await run(table.putMany([row({tokenId: 'a', fetchedAt: 2})]))
    const got = await run(table.getMany('mainnet', ['a']))
    expect(got).toHaveLength(1)
    expect(got[0]?.fetchedAt).toBe(2)
  })
})
