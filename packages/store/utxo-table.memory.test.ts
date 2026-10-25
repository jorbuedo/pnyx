import {Effect, Exit} from 'effect'
import {beforeEach, describe, expect, it} from 'vitest'
import type {UtxoRow, UtxoTable} from './utxo-table.js'
import {MemoryUtxoTable} from './utxo-table.memory.js'

const ref = (overrides: Partial<UtxoRow> = {}) => ({
  groupId: 'g1',
  chainId: 'cardano',
  accountIndex: 0,
  ...overrides,
})

const utxo = (overrides: Partial<UtxoRow> = {}): UtxoRow => ({
  groupId: 'g1',
  chainId: 'cardano',
  accountIndex: 0,
  txHash: 'h1',
  txIndex: 0,
  address: 'addr1',
  quantity: '1000000',
  assets: [],
  ...overrides,
})

const run = <E, A>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect as Effect.Effect<A, never>)

describe('MemoryUtxoTable', () => {
  let table: UtxoTable

  beforeEach(async () => {
    table = await run(MemoryUtxoTable)
  })

  describe('put / list basics', () => {
    it('round-trips a single row', async () => {
      const u = utxo({txHash: 'h1', txIndex: 0})
      await run(table.put(u))
      const rows = await run(table.list(ref()))
      expect(rows).toEqual([u])
    })

    it('putMany inserts all rows', async () => {
      await run(
        table.putMany([
          utxo({txHash: 'h1', txIndex: 0}),
          utxo({txHash: 'h2', txIndex: 0}),
          utxo({txHash: 'h2', txIndex: 1}),
        ]),
      )
      const rows = await run(table.list(ref()))
      expect(rows).toHaveLength(3)
    })

    it('put upserts on duplicate (txHash, txIndex)', async () => {
      await run(table.put(utxo({txHash: 'h1', txIndex: 0, quantity: '100'})))
      await run(table.put(utxo({txHash: 'h1', txIndex: 0, quantity: '999'})))
      const rows = await run(table.list(ref()))
      expect(rows).toHaveLength(1)
      expect(rows[0]?.quantity).toBe('999')
    })

    it('isolates rows by ref partition', async () => {
      await run(table.put(utxo({txHash: 'h1', txIndex: 0})))
      await run(table.put({...utxo({txHash: 'h2', txIndex: 0}), accountIndex: 1}))
      const rows = await run(table.list(ref()))
      expect(rows).toHaveLength(1)
      expect(rows[0]?.txHash).toBe('h1')
    })
  })

  describe('list filters', () => {
    beforeEach(async () => {
      await run(
        table.putMany([
          utxo({txHash: 'pure-1', txIndex: 0, assets: []}),
          utxo({txHash: 'bundle-1', txIndex: 0, assets: [{id: 'asset1', quantity: '1'}]}),
          utxo({txHash: 'pure-2', txIndex: 0, assets: []}),
          utxo({txHash: 'bundle-2', txIndex: 0, assets: [{id: 'asset2', quantity: '5'}]}),
        ]),
      )
    })

    it('returns all rows when no filter is set', async () => {
      const rows = await run(table.list(ref()))
      expect(rows).toHaveLength(4)
    })

    it('pureOnly excludes rows with non-empty assets', async () => {
      const rows = await run(table.list({...ref(), pureOnly: true}))
      expect(rows.map((r) => r.txHash).sort()).toEqual(['pure-1', 'pure-2'])
    })
  })

  describe('delete', () => {
    beforeEach(async () => {
      await run(
        table.putMany([
          utxo({txHash: 'h1', txIndex: 0}),
          utxo({txHash: 'h1', txIndex: 1}),
          utxo({txHash: 'h2', txIndex: 0}),
        ]),
      )
    })

    it('removes specified keys', async () => {
      await run(
        table.delete(ref(), [
          {txHash: 'h1', txIndex: 0},
          {txHash: 'h2', txIndex: 0},
        ]),
      )
      const rows = await run(table.list(ref()))
      expect(rows.map((r) => `${r.txHash}#${r.txIndex}`)).toEqual(['h1#1'])
    })

    it('is a no-op for unknown keys', async () => {
      await run(table.delete(ref(), [{txHash: 'unknown', txIndex: 0}]))
      const rows = await run(table.list(ref()))
      expect(rows).toHaveLength(3)
    })
  })

  describe('replaceAll', () => {
    it('wipes the partition and inserts the new set', async () => {
      await run(table.putMany([utxo({txHash: 'old-1', txIndex: 0}), utxo({txHash: 'old-2', txIndex: 0})]))
      await run(
        table.replaceAll(ref(), [
          utxo({txHash: 'new-1', txIndex: 0}),
          utxo({txHash: 'new-2', txIndex: 0}),
          utxo({txHash: 'new-3', txIndex: 0}),
        ]),
      )
      const rows = await run(table.list(ref()))
      expect(rows.map((r) => r.txHash).sort()).toEqual(['new-1', 'new-2', 'new-3'])
    })

    it('leaves other partitions untouched', async () => {
      const otherRef = {...ref(), accountIndex: 1}
      await run(table.put({...utxo({txHash: 'keep', txIndex: 0}), accountIndex: 1}))
      await run(table.put(utxo({txHash: 'before', txIndex: 0})))
      await run(table.replaceAll(ref(), [utxo({txHash: 'after', txIndex: 0})]))

      const a = await run(table.list(ref()))
      const b = await run(table.list(otherRef))
      expect(a.map((r) => r.txHash)).toEqual(['after'])
      expect(b.map((r) => r.txHash)).toEqual(['keep'])
    })

    it('clears partition when called with empty rows', async () => {
      await run(table.put(utxo({txHash: 'h1', txIndex: 0})))
      await run(table.replaceAll(ref(), []))
      const rows = await run(table.list(ref()))
      expect(rows).toEqual([])
    })
  })

  describe('count', () => {
    it('returns 0 for empty partition', async () => {
      expect(await run(table.count(ref()))).toBe(0)
    })

    it('counts only the matching partition', async () => {
      await run(table.putMany([utxo({txHash: 'h1', txIndex: 0}), utxo({txHash: 'h2', txIndex: 0})]))
      await run(table.put({...utxo({txHash: 'other', txIndex: 0}), accountIndex: 1}))
      expect(await run(table.count(ref()))).toBe(2)
    })
  })

  describe('clear', () => {
    it('removes only the matching partition', async () => {
      await run(table.put(utxo({txHash: 'h1', txIndex: 0})))
      await run(table.put({...utxo({txHash: 'other', txIndex: 0}), accountIndex: 1}))
      await run(table.clear(ref()))
      const a = await run(table.list(ref()))
      const b = await run(table.list({...ref(), accountIndex: 1}))
      expect(a).toEqual([])
      expect(b).toHaveLength(1)
    })
  })

  describe('close', () => {
    it('returns StoreClosedError after close()', async () => {
      await run(table.close())
      const exit = await Effect.runPromiseExit(table.list(ref()))
      expect(Exit.isFailure(exit)).toBe(true)
    })
  })
})
