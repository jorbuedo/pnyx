import {describe, expect, it, vi} from 'vitest'

import {blockAtOrBefore} from './block-at-time'

/** A chain of `tip` blocks, six seconds apart, starting at `genesisMs`. */
const chain = (tip: number, genesisMs = 1_000_000) => ({
  tip,
  read: async (height: number) => (height >= 1 && height <= tip ? genesisMs + (height - 1) * 6_000 : null),
})

describe('blockAtOrBefore', () => {
  it('finds the block a moment falls in', async () => {
    const c = chain(1_000_000)
    // Block 500 is at genesis + 499*6000. Ask three seconds into it: still block 500.
    const result = await blockAtOrBefore({
      targetMs: 1_000_000 + 499 * 6_000 + 3_000,
      tipHeight: c.tip,
      readTimestamp: c.read,
    })
    expect(result).toMatchObject({kind: 'found', height: 500})
  })

  it('rounds DOWN, never up', async () => {
    // ⚠️ The rule the whole module exists for. One millisecond before block 500 must answer 499: a
    // birthday later than the truth skips the blocks between, silently and for good.
    const c = chain(1_000_000)
    const result = await blockAtOrBefore({
      targetMs: 1_000_000 + 499 * 6_000 - 1,
      tipHeight: c.tip,
      readTimestamp: c.read,
    })
    expect(result).toMatchObject({kind: 'found', height: 499})
  })

  it('lands exactly on a block whose timestamp is the target', async () => {
    const c = chain(1_000)
    const result = await blockAtOrBefore({targetMs: 1_000_000 + 499 * 6_000, tipHeight: c.tip, readTimestamp: c.read})
    expect(result).toMatchObject({kind: 'found', height: 500})
  })

  it('answers the tip for a target in the future, in one read', async () => {
    // The common case for a backfill is a wallet created recently, and paying twenty requests for it
    // would be twenty requests spent on the answer that needed none.
    const c = chain(1_000_000)
    const result = await blockAtOrBefore({targetMs: Date.now() + 1_000_000, tipHeight: c.tip, readTimestamp: c.read})
    expect(result).toMatchObject({kind: 'found', height: 1_000_000, reads: 1})
  })

  it('says before-genesis rather than answering block 1', async () => {
    // Block 1 is not "the block that moment falls in" — the chain did not exist. A caller may still
    // choose to start at 1, but it must make that choice knowing.
    const c = chain(1_000, 5_000_000)
    const result = await blockAtOrBefore({targetMs: 1_000, tipHeight: c.tip, readTimestamp: c.read})
    expect(result.kind).toBe('before-genesis')
  })

  it('stops on a gap instead of narrowing on no evidence', async () => {
    // ⚠️ Guessing past an unanswerable height picks a bound from nothing, and the result is a birthday
    // nobody could tell was wrong.
    const c = chain(1_000_000)
    const holed = async (height: number) => (height === 500_000 ? null : c.read(height))
    const result = await blockAtOrBefore({
      targetMs: 1_000_000 + 400_000 * 6_000,
      tipHeight: 1_000_000,
      readTimestamp: holed,
    })
    expect(result).toMatchObject({kind: 'unreadable', atHeight: 500_000})
  })

  it('is logarithmic, not linear', async () => {
    // Twenty-odd reads over a million blocks is what makes this affordable on a phone; a linear walk
    // would be the thing the birthday exists to avoid.
    const c = chain(1_000_000)
    const spy = vi.fn(c.read)
    const result = await blockAtOrBefore({targetMs: 1_000_000 + 123_456 * 6_000, tipHeight: c.tip, readTimestamp: spy})
    expect(result).toMatchObject({kind: 'found', height: 123_457})
    expect(spy.mock.calls.length).toBeLessThan(25)
  })

  it('handles a chain with no blocks at all', async () => {
    expect(await blockAtOrBefore({targetMs: 1, tipHeight: 0, readTimestamp: async () => null})).toMatchObject({
      kind: 'before-genesis',
    })
  })
})
