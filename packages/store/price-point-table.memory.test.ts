import {Effect} from 'effect'
import {beforeEach, describe, expect, it} from 'vitest'
import type {PricePointRow, PricePointTable} from './price-point-table.js'
import {MemoryPricePointTable} from './price-point-table.memory.js'

const row = (overrides: Partial<PricePointRow> = {}): PricePointRow => ({
  network: 'mainnet',
  seriesKey: 'adafiat:USD',
  tsBucket: 1_700_000_000,
  value: 0.5,
  source: 'kraken',
  ...overrides,
})

const run = <E, A>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect as Effect.Effect<A, never>)

describe('MemoryPricePointTable', () => {
  let table: PricePointTable

  beforeEach(async () => {
    table = await run(MemoryPricePointTable)
  })

  it('round-trips a series and returns ascending points in range', async () => {
    await run(
      table.putMany([
        row({tsBucket: 300}),
        row({tsBucket: 100}),
        row({tsBucket: 200}),
        row({tsBucket: 999, seriesKey: 'tokenada:x'}),
      ]),
    )
    const got = await run(table.getRange('mainnet', 'adafiat:USD', 0, 1000))
    expect(got.map((r) => r.tsBucket)).toEqual([100, 200, 300]) // sorted, other series excluded
  })

  it('range is inclusive and bounded', async () => {
    await run(table.putMany([row({tsBucket: 100}), row({tsBucket: 200}), row({tsBucket: 300})]))
    const got = await run(table.getRange('mainnet', 'adafiat:USD', 100, 200))
    expect(got.map((r) => r.tsBucket)).toEqual([100, 200])
  })

  it('upserts by (network, seriesKey, tsBucket)', async () => {
    await run(table.putMany([row({tsBucket: 100, value: 1})]))
    await run(table.putMany([row({tsBucket: 100, value: 2})]))
    const got = await run(table.getRange('mainnet', 'adafiat:USD', 100, 100))
    expect(got).toHaveLength(1)
    expect(got[0]?.value).toBe(2)
  })

  it('prune drops only points older than beforeTsBucket for that series', async () => {
    await run(table.putMany([row({tsBucket: 100}), row({tsBucket: 200}), row({tsBucket: 300})]))
    await run(table.prune('mainnet', 'adafiat:USD', 200))
    const got = await run(table.getRange('mainnet', 'adafiat:USD', 0, 1000))
    expect(got.map((r) => r.tsBucket)).toEqual([200, 300])
  })

  it('partitions by network; clear wipes one network only', async () => {
    await run(table.putMany([row({network: 'mainnet', tsBucket: 100}), row({network: 'testnet', tsBucket: 100})]))
    await run(table.clear('mainnet'))
    expect(await run(table.getRange('mainnet', 'adafiat:USD', 0, 1000))).toHaveLength(0)
    expect(await run(table.getRange('testnet', 'adafiat:USD', 0, 1000))).toHaveLength(1)
  })
})
