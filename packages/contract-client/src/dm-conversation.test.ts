import {describe, expect, it} from 'vitest'
import {conversationId, isConversationBetween} from './dm-conversation'

const ALICE = 'mn_addr1alice'
const BOB = 'mn_addr1bob'

describe('conversationId', () => {
  // ⚠️ Known-answer vectors, computed with the implementation this module replaced (SHA-256 via
  // node:crypto, hex via Buffer) before it moved out of the wallet app on 2026-09-01. The move
  // changed both the hash import and the hex encoder, and the service now *verifies* what the
  // client derives — so a drift of one byte would silently make every thread unaddressable.
  it('matches the derivation it was moved from, byte for byte', () => {
    expect(conversationId(ALICE, BOB)).toBe('ce345d033d60f01fcd2e782339a394b2346d2a2a8c5b58ba80cbde1381e5097c')
    expect(conversationId('dev:alice', 'dev:bob')).toBe(
      'e897dfe79a6feac85e48c84133c1f7e736207148eb6dc6529eaca535e8a84904',
    )
  })

  it('is order-independent, so both sides name the thread the same', () => {
    expect(conversationId(BOB, ALICE)).toBe(conversationId(ALICE, BOB))
  })

  it('is 64 lower-case hex, the shape of a path segment and a D1 key', () => {
    expect(conversationId(ALICE, BOB)).toMatch(/^[0-9a-f]{64}$/)
  })

  // `|` cannot occur in bech32, so no two distinct pairs can encode to one input.
  it('does not collide when a boundary is moved between the two ids', () => {
    expect(conversationId('mn_addr1aa', 'mn_addr1bb')).not.toBe(conversationId('mn_addr1aab', 'mn_addr1b'))
  })
})

describe('isConversationBetween', () => {
  it('accepts the pair that names the conversation, in either order', () => {
    const id = conversationId(ALICE, BOB)
    expect(isConversationBetween(id, ALICE, BOB)).toBe(true)
    expect(isConversationBetween(id, BOB, ALICE)).toBe(true)
  })

  // The delivery gate: a third party cannot name a conversation they are not in.
  it('rejects a pair that does not', () => {
    const id = conversationId(ALICE, BOB)
    expect(isConversationBetween(id, ALICE, 'mn_addr1mallory')).toBe(false)
    expect(isConversationBetween(id, 'mn_addr1mallory', BOB)).toBe(false)
  })

  it('rejects a conversation id that names nothing', () => {
    expect(isConversationBetween('0'.repeat(64), ALICE, BOB)).toBe(false)
  })
})
