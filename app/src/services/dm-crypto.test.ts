import {describe, expect, it} from 'vitest'

import {conversationId} from './dm-crypto'

const ALICE = 'mn_addr1alicexxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
const BOB = 'mn_addr1bobxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'

describe('conversationId', () => {
  it('is order-independent so both clients agree without a round-trip', () => {
    expect(conversationId(ALICE, BOB)).toBe(conversationId(BOB, ALICE))
  })

  it('is distinct per pair and hex-encoded 32 bytes', () => {
    const carol = 'mn_addr1carolxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
    expect(conversationId(ALICE, BOB)).not.toBe(conversationId(ALICE, carol))
    expect(conversationId(ALICE, BOB)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('does not collide when a separator-like sequence appears in an address', () => {
    // The `|` separator cannot occur in bech32, so pair boundaries are unambiguous.
    expect(conversationId('mn_addr1aa', 'mn_addr1bb')).not.toBe(conversationId('mn_addr1aab', 'mn_addr1b'))
  })
})
