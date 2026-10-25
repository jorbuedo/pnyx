import type {ChainId} from '@pnyx/config'
import {describe, expect, it} from 'vitest'

import {chainKeepsSnapshots} from './snapshot-expectation'

describe('chainKeepsSnapshots', () => {
  it('is true for Cardano, the one rail that writes snapshots', () => {
    expect(chainKeepsSnapshots('cardano:mainnet' as ChainId)).toBe(true)
    expect(chainKeepsSnapshots('cardano:preprod' as ChainId)).toBe(true)
  })

  // Midnight keeps its state in the unshielded cache, the shielded state and the DUST state. Warning
  // that it produced no snapshot described the design once a minute per chain, for ever.
  it('is false for Midnight', () => {
    expect(chainKeepsSnapshots('midnight:mainnet' as ChainId)).toBe(false)
  })

  // An allowlist, not a denylist: a family added later holds its own state until somebody teaches it
  // to write snapshots, and the cost of being wrong that way is a missing log line rather than a
  // warning nobody reads.
  it.each([
    'bip122:000000000019d6689c085ae165831e93',
    'eip155:1',
    'solana:mainnet',
  ])('is false for %s, which was never taught to write one', (chainId) => {
    expect(chainKeepsSnapshots(chainId as ChainId)).toBe(false)
  })
})
