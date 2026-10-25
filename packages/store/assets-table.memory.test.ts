import {Effect} from 'effect'
import {beforeEach, describe, expect, it} from 'vitest'
import type {AssetRow, AssetsTable} from './assets-table.js'
import {MemoryAssetsTable} from './assets-table.memory.js'

const ref = (overrides: Partial<AssetRow> = {}) => ({
  groupId: 'g1',
  chainId: 'cardano',
  accountIndex: 0,
  ...overrides,
})

const asset = (overrides: Partial<AssetRow> = {}): AssetRow => ({
  groupId: 'g1',
  chainId: 'cardano',
  accountIndex: 0,
  id: 'lovelace',
  assetType: 'TOKEN',
  usdValue: 100,
  assetNumber: 1,
  detailJson: '{}',
  ...overrides,
})

const run = <E, A>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect as Effect.Effect<A, never>)

describe('MemoryAssetsTable', () => {
  let table: AssetsTable

  beforeEach(async () => {
    table = await run(MemoryAssetsTable)
  })

  it('replaceAll round-trips rows, sorted by usdValue desc', async () => {
    await run(
      table.replaceAll(ref(), [
        asset({id: 'a', usdValue: 10}),
        asset({id: 'b', usdValue: 300}),
        asset({id: 'c', usdValue: 50}),
      ]),
    )
    const rows = await run(table.list(ref()))
    expect(rows.map((r) => r.id)).toEqual(['b', 'c', 'a'])
  })

  it('replaceAll swaps the whole partition (no stale rows)', async () => {
    await run(table.replaceAll(ref(), [asset({id: 'a'}), asset({id: 'b'})]))
    await run(table.replaceAll(ref(), [asset({id: 'c'})]))
    const rows = await run(table.list(ref()))
    expect(rows.map((r) => r.id)).toEqual(['c'])
  })

  it('partitions by ref — never leaks across wallets/accounts', async () => {
    await run(table.replaceAll(ref(), [asset({id: 'a'})]))
    await run(
      table.replaceAll(ref({accountIndex: 1}), [asset({accountIndex: 1, id: 'x'}), asset({accountIndex: 1, id: 'y'})]),
    )
    expect((await run(table.list(ref()))).map((r) => r.id)).toEqual(['a'])
    expect(await run(table.count(ref({accountIndex: 1})))).toBe(2)
  })

  it('limit/offset page the top holdings', async () => {
    await run(
      table.replaceAll(ref(), [
        asset({id: 'a', usdValue: 10}),
        asset({id: 'b', usdValue: 300}),
        asset({id: 'c', usdValue: 50}),
      ]),
    )
    expect((await run(table.list({...ref(), limit: 2}))).map((r) => r.id)).toEqual(['b', 'c'])
    expect((await run(table.list({...ref(), limit: 2, offset: 2}))).map((r) => r.id)).toEqual(['a'])
  })

  it('clear wipes the partition', async () => {
    await run(table.replaceAll(ref(), [asset({id: 'a'})]))
    await run(table.clear(ref()))
    expect(await run(table.count(ref()))).toBe(0)
  })
})
