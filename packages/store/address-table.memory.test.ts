import {Effect} from 'effect'
import {beforeEach, describe, expect, it} from 'vitest'
import type {AddressBranch, AddressRow, AddressTable} from './address-table.js'
import {MemoryAddressTable} from './address-table.memory.js'

const ref = (overrides: Partial<{groupId: string; chainId: string; accountIndex: number}> = {}) => ({
  groupId: 'g1',
  chainId: 'cardano',
  accountIndex: 0,
  ...overrides,
})

const addr = (overrides: Partial<AddressRow> = {}): AddressRow => ({
  groupId: 'g1',
  chainId: 'cardano',
  accountIndex: 0,
  branch: 'external' as AddressBranch,
  index: 0,
  human: 'addr1q0',
  hash: 'hash0',
  isUsed: false,
  ...overrides,
})

const run = <E, A>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect as Effect.Effect<A, never>)

describe('MemoryAddressTable', () => {
  let table: AddressTable

  beforeEach(async () => {
    table = await run(MemoryAddressTable)
  })

  describe('upsert / list basics', () => {
    it('round-trips a single row', async () => {
      const a = addr({branch: 'external', index: 0, human: 'addr1q0'})
      await run(table.upsert(a))
      const rows = await run(table.list(ref()))
      expect(rows).toEqual([a])
    })

    it('upsertMany inserts all rows', async () => {
      await run(
        table.upsertMany([
          addr({branch: 'external', index: 0, human: 'addr1q0'}),
          addr({branch: 'external', index: 1, human: 'addr1q1'}),
          addr({branch: 'internal', index: 0, human: 'addr1q2'}),
        ]),
      )
      const rows = await run(table.list(ref()))
      expect(rows).toHaveLength(3)
    })

    it('upsert replaces on duplicate (branch, index)', async () => {
      await run(table.upsert(addr({branch: 'external', index: 0, isUsed: false})))
      await run(table.upsert(addr({branch: 'external', index: 0, isUsed: true})))
      const rows = await run(table.list(ref()))
      expect(rows).toHaveLength(1)
      expect(rows[0]?.isUsed).toBe(true)
    })

    it('isolates rows by ref partition', async () => {
      await run(table.upsert(addr({branch: 'external', index: 0, human: 'a'})))
      await run(table.upsert(addr({branch: 'external', index: 0, human: 'b', accountIndex: 1})))
      const rows = await run(table.list(ref()))
      expect(rows).toHaveLength(1)
      expect(rows[0]?.human).toBe('a')
    })
  })

  describe('list filters', () => {
    beforeEach(async () => {
      await run(
        table.upsertMany([
          addr({branch: 'external', index: 0, human: 'ext0', isUsed: true}),
          addr({branch: 'external', index: 1, human: 'ext1', isUsed: true}),
          addr({branch: 'external', index: 2, human: 'ext2', isUsed: false}),
          addr({branch: 'internal', index: 0, human: 'int0', isUsed: true}),
          addr({branch: 'internal', index: 1, human: 'int1', isUsed: false}),
          // Sibling wallet, same chain
          addr({groupId: 'g2', branch: 'external', index: 0, human: 'g2ext0', isUsed: true}),
          // Sibling chain, same wallet
          addr({chainId: 'bitcoin', branch: 'single', index: 0, human: 'bc1q', isUsed: true}),
        ]),
      )
    })

    it('filters by branch', async () => {
      const rows = await run(table.list({...ref(), branch: 'external'}))
      expect(rows.map((r) => r.human)).toEqual(['ext0', 'ext1', 'ext2'])
    })

    it('filters by isUsed', async () => {
      const used = await run(table.list({...ref(), isUsed: true}))
      expect(used.map((r) => r.human).sort()).toEqual(['ext0', 'ext1', 'int0'])
      const unused = await run(table.list({...ref(), isUsed: false}))
      expect(unused.map((r) => r.human).sort()).toEqual(['ext2', 'int1'])
    })

    it('filters by branch and isUsed combined', async () => {
      const rows = await run(table.list({...ref(), branch: 'external', isUsed: true}))
      expect(rows.map((r) => r.human)).toEqual(['ext0', 'ext1'])
    })

    it('cross-wallet scan by chainId and isUsed', async () => {
      const rows = await run(table.list({chainId: 'cardano', isUsed: true}))
      expect(rows.map((r) => r.human).sort()).toEqual(['ext0', 'ext1', 'g2ext0', 'int0'])
    })

    it('returns all rows when query is empty', async () => {
      const rows = await run(table.list({}))
      expect(rows).toHaveLength(7)
    })
  })

  describe('list ordering', () => {
    it('orders by (groupId, chainId, accountIndex, branch, index)', async () => {
      await run(
        table.upsertMany([
          addr({branch: 'internal', index: 1, human: 'int1'}),
          addr({branch: 'external', index: 2, human: 'ext2'}),
          addr({branch: 'internal', index: 0, human: 'int0'}),
          addr({branch: 'external', index: 0, human: 'ext0'}),
          addr({branch: 'external', index: 1, human: 'ext1'}),
        ]),
      )
      const rows = await run(table.list(ref()))
      expect(rows.map((r) => `${r.branch}#${r.index}`)).toEqual([
        'external#0',
        'external#1',
        'external#2',
        'internal#0',
        'internal#1',
      ])
    })
  })

  describe('get', () => {
    it('returns the row by (ref, branch, index)', async () => {
      await run(table.upsert(addr({branch: 'external', index: 5, human: 'addr-five'})))
      const row = await run(table.get(ref(), 'external', 5))
      expect(row?.human).toBe('addr-five')
    })

    it('returns null when missing', async () => {
      const row = await run(table.get(ref(), 'external', 999))
      expect(row).toBeNull()
    })
  })

  describe('count', () => {
    beforeEach(async () => {
      await run(
        table.upsertMany([
          addr({branch: 'external', index: 0, isUsed: true}),
          addr({branch: 'external', index: 1, isUsed: true}),
          addr({branch: 'internal', index: 0, isUsed: false}),
        ]),
      )
    })

    it('counts by partition', async () => {
      expect(await run(table.count(ref()))).toBe(3)
    })

    it('counts by partition + branch', async () => {
      expect(await run(table.count({...ref(), branch: 'external'}))).toBe(2)
    })

    it('counts by partition + branch + isUsed', async () => {
      expect(await run(table.count({...ref(), branch: 'external', isUsed: true}))).toBe(2)
      expect(await run(table.count({...ref(), branch: 'external', isUsed: false}))).toBe(0)
    })
  })

  describe('clear', () => {
    it('removes only rows in the partition', async () => {
      await run(
        table.upsertMany([
          addr({branch: 'external', index: 0}),
          addr({branch: 'external', index: 0, accountIndex: 1}),
          addr({branch: 'external', index: 0, chainId: 'bitcoin', human: 'bc1'}),
        ]),
      )
      await run(table.clear(ref()))
      const all = await run(table.list({}))
      expect(all).toHaveLength(2)
      expect(all.every((r) => !(r.accountIndex === 0 && r.chainId === 'cardano'))).toBe(true)
    })
  })

  describe('invariants', () => {
    it('isUsed=true survives an upsert that keeps the value', async () => {
      await run(table.upsert(addr({branch: 'external', index: 0, isUsed: true})))
      await run(table.upsert(addr({branch: 'external', index: 0, isUsed: true, human: 'addr1q0-v2'})))
      const row = await run(table.get(ref(), 'external', 0))
      expect(row?.isUsed).toBe(true)
      expect(row?.human).toBe('addr1q0-v2')
    })

    it('single and external/internal can coexist in different partitions but not the same one (caller invariant)', async () => {
      // The table itself doesn't enforce this — it's a caller invariant
      // documented on AddressBranch. The test asserts the table doesn't
      // accidentally merge or reject them when used in different partitions.
      await run(table.upsert(addr({branch: 'single', index: 0, chainId: 'bitcoin'})))
      await run(table.upsert(addr({branch: 'external', index: 0, chainId: 'cardano'})))
      const rows = await run(table.list({}))
      expect(rows.map((r) => r.branch).sort()).toEqual(['external', 'single'])
    })
  })

  describe('close', () => {
    it('fails reads and writes after close', async () => {
      await run(table.close())
      await expect(run(table.upsert(addr()))).rejects.toThrow()
      await expect(run(table.list({}))).rejects.toThrow()
    })
  })
})
