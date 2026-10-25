import {describe, expect, it} from 'vitest'

import {blocksSubscription, collectBlocks} from './block-stream'

const block = (height: number) => ({blocks: {height, zswapMerkleTreeRoot: `root-${height}`}})

describe('blocksSubscription', () => {
  it('asks for the same fields the batched query does', () => {
    const query = blocksSubscription()
    // The walk applies `raw` and decides with `transactionResult`; a field missing here is a block the
    // native wallet cannot apply, which would look like an empty chain rather than a broken query.
    for (const field of ['raw', 'transactionResult', 'zswapMerkleTreeRoot', 'height', 'segments']) {
      expect(query).toContain(field)
    }
    expect(query).toContain('blocks(offset: {height: $height})')
  })
})

describe('collectBlocks', () => {
  it('takes the range and stops at its end', () => {
    const collector = collectBlocks(10, 12)
    expect(collector.accept(block(10))).toBe('continue')
    expect(collector.accept(block(11))).toBe('continue')
    // The feed does not end at a height — it stays open for live blocks — so stopping is the caller's
    // job and this is where it happens.
    expect(collector.accept(block(12))).toBe('stop')
    expect(collector.blocks().map((b) => b.height)).toEqual([10, 11, 12])
    expect(collector.end()).toEqual({kind: 'complete'})
  })

  it('stops at a height it did not expect rather than applying it', () => {
    // Order is the commitment tree's index. A block applied out of sequence puts our coins where the
    // chain put other commitments, and every proof from that tree fails — so a gap ends the walk.
    const collector = collectBlocks(10, 20)
    collector.accept(block(10))
    expect(collector.accept(block(12))).toBe('stop')
    expect(collector.blocks().map((b) => b.height)).toEqual([10])
    expect(collector.end()).toEqual({kind: 'gap', expected: 11, got: 12})
  })

  it('ignores a payload with no block rather than ending on it', () => {
    const collector = collectBlocks(10, 11)
    expect(collector.accept({})).toBe('continue')
    expect(collector.accept({blocks: null})).toBe('continue')
    expect(collector.end()).toBeUndefined()
    expect(collector.accept(block(10))).toBe('continue')
  })

  it('ignores frames that arrive after it has stopped', () => {
    // Measured on device: unsubscribing does not recall what the socket already buffered, and taking
    // those frames made a 1,000-block window 1,013 long. The danger is not the extra blocks — they were
    // consecutive — but that one out of sequence would rewrite a finished window's verdict as a gap.
    const collector = collectBlocks(10, 11)
    collector.accept(block(10))
    expect(collector.accept(block(11))).toBe('stop')
    expect(collector.accept(block(12))).toBe('stop')
    expect(collector.accept(block(99))).toBe('stop')
    expect(collector.blocks().map((b) => b.height)).toEqual([10, 11])
    expect(collector.end()).toEqual({kind: 'complete'})
  })

  it('is complete after a single-block range', () => {
    const collector = collectBlocks(7, 7)
    expect(collector.accept(block(7))).toBe('stop')
    expect(collector.end()).toEqual({kind: 'complete'})
  })
})
