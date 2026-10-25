import {describe, expect, it} from 'vitest'
import {anchorKindFor, generationsQuery, generationsSubscription} from './dust-generations-query'

const ADDR = 'mn_dust_preprod1abc'
const HASH = '6027338051c72e87702d083dcd835e44e4ce1cdef9649b4fbf628158a3e56bb0'

describe('anchorKindFor', () => {
  it('names the anchor each implemented shape needs', () => {
    expect(anchorKindFor({kind: 'index-range'})).toBe('index-range')
    expect(anchorKindFor({kind: 'block-anchored'})).toBe('block-anchored')
  })

  it('has no anchor for a shape we do not implement', () => {
    expect(anchorKindFor({kind: 'unrecognised', args: ['dustAddress', 'somethingNew']})).toBeNull()
  })
})

describe('generationsQuery — index range', () => {
  it('passes the window through as start and end', () => {
    const q = generationsQuery({kind: 'index-range', start: 0, end: 238_000}, ADDR, true)
    expect(q.args).toBe('dustAddress: $addr, startIndex: $start, endIndex: $end')
    expect(q.variables).toEqual({addr: ADDR, start: 0, end: 238_000})
  })

  it('is unaffected by the dtime flag — the selection set decides there, not an argument', () => {
    const withUpdates = generationsQuery({kind: 'index-range', start: 1, end: 2}, ADDR, true)
    const without = generationsQuery({kind: 'index-range', start: 1, end: 2}, ADDR, false)
    expect(withUpdates).toEqual(without)
  })
})

describe('generationsQuery — block anchored', () => {
  it('pins the snapshot to the block it was given', () => {
    const q = generationsQuery({kind: 'block-anchored', blockHash: HASH, blockHeight: 615_356}, ADDR, false)
    expect(q.args).toBe('dustAddress: $addr, blockHash: $block, dtimeCutoffHeight: $cutoff')
    expect(q.variables.addr).toBe(ADDR)
    expect(q.variables.block).toBe(HASH)
  })

  it('cuts off at the snapshot height when dtime updates are not wanted', () => {
    const q = generationsQuery({kind: 'block-anchored', blockHash: HASH, blockHeight: 615_356}, ADDR, false)
    expect(q.variables.cutoff).toBe(615_356)
  })

  it('cuts off at zero when they are — a cutoff of 0 withholds none of them', () => {
    const q = generationsQuery({kind: 'block-anchored', blockHash: HASH, blockHeight: 615_356}, ADDR, true)
    expect(q.variables.cutoff).toBe(0)
  })

  it('never sends an index window, because the snapshot is the whole tree', () => {
    const q = generationsQuery({kind: 'block-anchored', blockHash: HASH, blockHeight: 7}, ADDR, true)
    expect(q.args).not.toContain('startIndex')
    expect(q.args).not.toContain('endIndex')
    expect(Object.keys(q.variables).sort()).toEqual(['addr', 'block', 'cutoff'])
  })
})

describe('generationsSubscription', () => {
  it('declares exactly the variables the argument list uses', () => {
    for (const anchor of [
      {kind: 'index-range', start: 0, end: 10} as const,
      {kind: 'block-anchored', blockHash: HASH, blockHeight: 10} as const,
    ]) {
      const q = generationsQuery(anchor, ADDR, true)
      const doc = generationsSubscription(q, '    ... on DustGenerationsProgress { highestIndex }')
      const used = [...q.args.matchAll(/\$(\w+)/g)].map((m) => m[1]).sort()
      const declared = [...q.signature.matchAll(/\$(\w+):/g)].map((m) => m[1]).sort()
      expect(declared).toEqual(used)
      for (const name of used) expect(doc).toContain(`$${name}`)
    }
  })

  it('keeps __typename, so a union member can be told apart', () => {
    const q = generationsQuery({kind: 'index-range', start: 0, end: 1}, ADDR, false)
    expect(generationsSubscription(q, '')).toContain('__typename')
  })
})
