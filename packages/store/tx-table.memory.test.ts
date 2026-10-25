import {Effect, Exit} from 'effect'
import {beforeEach, describe, expect, it} from 'vitest'
import type {TxRow, TxTable} from './tx-table.js'
import {MemoryTxTable} from './tx-table.memory.js'

const ref = (overrides: Partial<TxRow> = {}) => ({
  groupId: 'g1',
  chainId: 'cardano',
  accountIndex: 0,
  ...overrides,
})

const tx = (overrides: Partial<TxRow> = {}): TxRow => ({
  groupId: 'g1',
  chainId: 'cardano',
  accountIndex: 0,
  hash: 'h1',
  timestamp: 1_700_000_000,
  submittedAt: null,
  status: 'confirmed',
  type: 'receive',
  direction: 'received',
  amount: '1000000',
  fee: '180000',
  counterpartyAddress: 'addr1other',
  primaryAssetDelta: '1000000',
  additionalAssetCount: 0,
  hasNft: false,
  assetSymbol: 'ADA',
  assetDecimals: 6,
  iconUrl: null,
  tokenId: null,
  contractAddress: null,
  listMetaJson: null,
  detailJson: '{"raw":"payload"}',
  ...overrides,
})

const run = <E, A>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect as Effect.Effect<A, never>)

describe('MemoryTxTable', () => {
  let table: TxTable

  beforeEach(async () => {
    table = await run(MemoryTxTable)
  })

  describe('put / get / list basics', () => {
    it('round-trips a single row', async () => {
      await run(table.put(tx({hash: 'h1'})))
      const got = await run(table.get(ref(), 'h1'))
      expect(got).toEqual(tx({hash: 'h1'}))
    })

    it('get returns null for unknown hash', async () => {
      const got = await run(table.get(ref(), 'nope'))
      expect(got).toBeNull()
    })

    it('putMany inserts all rows', async () => {
      await run(table.putMany([tx({hash: 'h1'}), tx({hash: 'h2'}), tx({hash: 'h3'})]))
      const items = await run(table.list(ref()))
      expect(items).toHaveLength(3)
      expect(items.map((r) => r.hash).sort()).toEqual(['h1', 'h2', 'h3'])
    })

    it('put upserts on duplicate hash', async () => {
      await run(table.put(tx({hash: 'h1', status: 'pending'})))
      await run(table.put(tx({hash: 'h1', status: 'confirmed', amount: '999'})))
      const got = await run(table.get(ref(), 'h1'))
      expect(got?.status).toBe('confirmed')
      expect(got?.amount).toBe('999')
    })

    it('list omits detailJson (projection)', async () => {
      await run(table.put(tx({hash: 'h1', detailJson: '{"big":"blob"}'})))
      const items = await run(table.list(ref()))
      expect(items[0]).not.toHaveProperty('detailJson')
    })
  })

  describe('list sort and pagination', () => {
    beforeEach(async () => {
      await run(
        table.putMany([
          tx({hash: 'old', timestamp: 1_700_000_000}),
          tx({hash: 'new', timestamp: 1_700_000_200}),
          tx({hash: 'mid', timestamp: 1_700_000_100}),
        ]),
      )
    })

    it('sorts newest first by timestamp', async () => {
      const items = await run(table.list(ref()))
      expect(items.map((r) => r.hash)).toEqual(['new', 'mid', 'old'])
    })

    it('applies limit', async () => {
      const items = await run(table.list({...ref(), limit: 2}))
      expect(items.map((r) => r.hash)).toEqual(['new', 'mid'])
    })

    it('applies offset', async () => {
      const items = await run(table.list({...ref(), offset: 1}))
      expect(items.map((r) => r.hash)).toEqual(['mid', 'old'])
    })

    it('limit + offset paginate together', async () => {
      const items = await run(table.list({...ref(), offset: 1, limit: 1}))
      expect(items.map((r) => r.hash)).toEqual(['mid'])
    })

    it('null timestamps (pending) sort to the top', async () => {
      await run(table.put(tx({hash: 'pend', timestamp: null, status: 'pending'})))
      const items = await run(table.list(ref()))
      expect(items.map((r) => r.hash)).toEqual(['pend', 'new', 'mid', 'old'])
    })
  })

  describe('list filters', () => {
    beforeEach(async () => {
      await run(
        table.putMany([
          tx({hash: 'a', status: 'confirmed', type: 'receive', timestamp: 1_000}),
          tx({hash: 'b', status: 'pending', type: 'send', timestamp: 2_000}),
          tx({hash: 'c', status: 'failed', type: 'send', timestamp: 3_000}),
          tx({hash: 'd', status: 'confirmed', type: 'stake-delegation', timestamp: 4_000}),
        ]),
      )
    })

    it('filters by status', async () => {
      const items = await run(table.list({...ref(), status: 'confirmed'}))
      expect(items.map((r) => r.hash).sort()).toEqual(['a', 'd'])
    })

    it('filters by types (multiple)', async () => {
      const items = await run(table.list({...ref(), types: ['send', 'stake-delegation']}))
      expect(items.map((r) => r.hash).sort()).toEqual(['b', 'c', 'd'])
    })

    it('filters by newerThan (strict)', async () => {
      const items = await run(table.list({...ref(), newerThan: 2_000}))
      expect(items.map((r) => r.hash).sort()).toEqual(['c', 'd'])
    })

    it('filters by olderThan (strict)', async () => {
      const items = await run(table.list({...ref(), olderThan: 3_000}))
      expect(items.map((r) => r.hash).sort()).toEqual(['a', 'b'])
    })

    it('newerThan excludes null-timestamp rows', async () => {
      await run(table.put(tx({hash: 'pend', timestamp: null})))
      const items = await run(table.list({...ref(), newerThan: 0}))
      expect(items.map((r) => r.hash)).not.toContain('pend')
    })
  })

  describe('multi-ref partitioning', () => {
    it('list scopes by ref', async () => {
      await run(
        table.putMany([
          tx({hash: 'a', groupId: 'g1', chainId: 'cardano'}),
          tx({hash: 'b', groupId: 'g1', chainId: 'eip155:8453'}),
          tx({hash: 'c', groupId: 'g2', chainId: 'cardano'}),
        ]),
      )
      const cardano = await run(table.list({groupId: 'g1', chainId: 'cardano', accountIndex: 0}))
      expect(cardano.map((r) => r.hash)).toEqual(['a'])
    })

    it('clear is scoped by ref', async () => {
      await run(
        table.putMany([
          tx({hash: 'a', groupId: 'g1', chainId: 'cardano'}),
          tx({hash: 'b', groupId: 'g1', chainId: 'eip155:8453'}),
        ]),
      )
      await run(table.clear({groupId: 'g1', chainId: 'cardano', accountIndex: 0}))
      expect(await run(table.list({groupId: 'g1', chainId: 'cardano', accountIndex: 0}))).toEqual([])
      expect(await run(table.list({groupId: 'g1', chainId: 'eip155:8453', accountIndex: 0}))).toHaveLength(1)
    })
  })

  describe('prune', () => {
    beforeEach(async () => {
      await run(
        table.putMany([
          tx({hash: 'oldest', timestamp: 1_000}),
          tx({hash: 'older', timestamp: 2_000}),
          tx({hash: 'newer', timestamp: 3_000}),
          tx({hash: 'newest', timestamp: 4_000}),
        ]),
      )
    })

    it('keeps the newest N and deletes the rest', async () => {
      const deleted = await run(table.prune(ref(), 2))
      expect(deleted).toBe(2)
      const items = await run(table.list(ref()))
      expect(items.map((r) => r.hash)).toEqual(['newest', 'newer'])
    })

    it('no-op when keepCount >= row count', async () => {
      const deleted = await run(table.prune(ref(), 10))
      expect(deleted).toBe(0)
      const items = await run(table.list(ref()))
      expect(items).toHaveLength(4)
    })

    it('only prunes the matching ref', async () => {
      await run(table.put(tx({hash: 'x', chainId: 'eip155:8453'})))
      await run(table.prune({groupId: 'g1', chainId: 'cardano', accountIndex: 0}, 0))
      expect(await run(table.list({groupId: 'g1', chainId: 'cardano', accountIndex: 0}))).toEqual([])
      expect(await run(table.list({groupId: 'g1', chainId: 'eip155:8453', accountIndex: 0}))).toHaveLength(1)
    })
  })

  describe('close', () => {
    it('rejects subsequent operations with StoreClosedError', async () => {
      await run(table.put(tx()))
      await run(table.close())
      const result = await Effect.runPromiseExit(table.get(ref(), 'h1'))
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) {
        const cause = result.cause
        const errStr = JSON.stringify(cause)
        expect(errStr).toContain('StoreClosedError')
      }
    })

    it('close is idempotent', async () => {
      await run(table.close())
      await run(table.close())
    })
  })
})
