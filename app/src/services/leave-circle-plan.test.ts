import {describe, expect, it} from 'vitest'
import {leavePlan} from './leave-circle-plan'

describe('leavePlan', () => {
  it('removes the leaf before the row, so nobody is un-listed while still provably a member', () => {
    expect(leavePlan({contractAddress: 'ab'.repeat(32), hasForumRoot: true})).toEqual({
      kind: 'chain-then-content',
      contractAddress: 'ab'.repeat(32),
    })
  })

  it('drops only the row for a circle that never confirmed — there is no leaf to remove', () => {
    expect(leavePlan({contractAddress: undefined, hasForumRoot: true})).toEqual({kind: 'content-only'})
  })

  // ⚠️ The case worth having a module for. Dropping the row alone would tell the leaver they had
  // left while every proof they can still make says they are a member — so it refuses instead.
  it('refuses rather than half-leaving when there is a leaf this device cannot remove', () => {
    expect(leavePlan({contractAddress: 'ab'.repeat(32), hasForumRoot: false})).toEqual({
      kind: 'blocked',
      reason: 'no-forum-root',
    })
  })

  it('still leaves an unconfirmed circle without a forum root, because no leaf is at stake', () => {
    expect(leavePlan({contractAddress: undefined, hasForumRoot: false})).toEqual({kind: 'content-only'})
  })
})
