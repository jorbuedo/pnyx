import {describe, expect, it} from 'vitest'

import {BLOCK_FIELDS} from './block-query'

describe('BLOCK_FIELDS', () => {
  it('does not ask for the transaction hash', () => {
    // ⚠️ It was queried for a long time and read by nothing. An unread field was complexity spent on
    // nothing when these were batched, and is bandwidth spent on nothing per block now they stream.
    expect(BLOCK_FIELDS).not.toContain('hash')
  })

  it('asks for the root, which is the only check that the tree is the chain’s', () => {
    expect(BLOCK_FIELDS).toContain('zswapMerkleTreeRoot')
  })

  it('asks for what decides whether a transaction may be applied at all', () => {
    expect(BLOCK_FIELDS).toContain('raw')
    expect(BLOCK_FIELDS).toContain('transactionResult')
    expect(BLOCK_FIELDS).toContain('segments')
  })

  it('asks for the height, which is what order is checked against', () => {
    // The stream is trusted for nothing: `collectBlocks` compares each frame's height to the one it
    // expected, and a fragment without it would make that check vacuous.
    expect(BLOCK_FIELDS).toContain('height')
  })
})
