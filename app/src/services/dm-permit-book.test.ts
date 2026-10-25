import {describe, expect, it} from 'vitest'
import {
  type DmIssuedInvite,
  type DmPermitBook,
  EMPTY_PERMIT_BOOK,
  forgetConversationPermits,
  forgetIssuedInvite,
  grantedPermitFor,
  heldPermitFor,
  isConversationMuted,
  liveIssuedInvites,
  rememberGrantedPermit,
  rememberHeldPermit,
  rememberIssuedInvite,
  setConversationMuted,
} from './dm-permit-book'

const CONV = 'a'.repeat(64)
const BOB = 'mn_addr1bob'

describe('held permits', () => {
  it('remembers a permit per peer and hands it back', () => {
    const book = rememberHeldPermit(EMPTY_PERMIT_BOOK, BOB, 'token-1')
    expect(heldPermitFor(book, BOB)).toBe('token-1')
    expect(heldPermitFor(book, 'mn_addr1carol')).toBeUndefined()
  })

  // A re-grant supersedes: the service reads a permit minted after a revocation as a deliberate
  // unmute, so keeping the older token would silently stay muted.
  it('lets a re-grant supersede the one it replaces', () => {
    const book = rememberHeldPermit(rememberHeldPermit(EMPTY_PERMIT_BOOK, BOB, 'old'), BOB, 'new')
    expect(heldPermitFor(book, BOB)).toBe('new')
  })
})

describe('granted permits', () => {
  it('remembers the id a peer is reaching us with', () => {
    const book = rememberGrantedPermit(EMPTY_PERMIT_BOOK, CONV, 'jti-1')
    expect(grantedPermitFor(book, CONV)).toBe('jti-1')
  })

  it('is a no-op when the id has not changed, so a poll does not churn the record', () => {
    const first = rememberGrantedPermit(EMPTY_PERMIT_BOOK, CONV, 'jti-1')
    expect(rememberGrantedPermit(first, CONV, 'jti-1')).toBe(first)
  })

  // ⚠️ The rule that keeps the mirror honest: a sender who lost their permit is auto-issued a fresh
  // one, and the old revocation does not cover it — so the conversation really is buzzing again.
  it('clears the mute when a new permit id appears', () => {
    const muted = setConversationMuted(rememberGrantedPermit(EMPTY_PERMIT_BOOK, CONV, 'jti-1'), CONV, true)
    expect(isConversationMuted(muted, CONV)).toBe(true)
    expect(isConversationMuted(rememberGrantedPermit(muted, CONV, 'jti-2'), CONV)).toBe(false)
  })

  it('keeps the mute while the id is unchanged', () => {
    const muted = setConversationMuted(rememberGrantedPermit(EMPTY_PERMIT_BOOK, CONV, 'jti-1'), CONV, true)
    expect(isConversationMuted(rememberGrantedPermit(muted, CONV, 'jti-1'), CONV)).toBe(true)
  })
})

describe('mute mirror', () => {
  it('sets and clears, and does not duplicate', () => {
    const once = setConversationMuted(EMPTY_PERMIT_BOOK, CONV, true)
    expect(setConversationMuted(once, CONV, true).muted).toEqual([CONV])
    expect(isConversationMuted(setConversationMuted(once, CONV, false), CONV)).toBe(false)
  })
})

describe('forgetting a conversation', () => {
  it('drops its permit id and its mute, leaving other conversations alone', () => {
    const other = 'b'.repeat(64)
    let book = rememberGrantedPermit(EMPTY_PERMIT_BOOK, CONV, 'jti-1')
    book = setConversationMuted(rememberGrantedPermit(book, other, 'jti-2'), CONV, true)
    const after = forgetConversationPermits(book, CONV)
    expect(grantedPermitFor(after, CONV)).toBeUndefined()
    expect(isConversationMuted(after, CONV)).toBe(false)
    expect(grantedPermitFor(after, other)).toBe('jti-2')
  })

  // Held permits are keyed by peer, not conversation: deleting a thread must not throw away the
  // capability to write to that person again.
  it('keeps a held permit, which is keyed by peer rather than conversation', () => {
    const book = rememberHeldPermit(rememberGrantedPermit(EMPTY_PERMIT_BOOK, CONV, 'jti-1'), BOB, 'token-1')
    expect(heldPermitFor(forgetConversationPermits(book, CONV), BOB)).toBe('token-1')
  })
})

describe('issued invitations', () => {
  const NOW = 1_788_000_000
  const invite = (jti: string, expiresAt: number): DmIssuedInvite => ({
    jti,
    link: `https://pnyx.pxkq.uk/dm/invite?permit=${jti}`,
    expiresAt,
    createdAt: NOW,
  })

  it('keeps an invitation whole, newest first', () => {
    const first = invite('one', NOW + 100)
    const second = invite('two', NOW + 200)
    const book = rememberIssuedInvite(rememberIssuedInvite(EMPTY_PERMIT_BOOK, first, NOW), second, NOW)
    expect(liveIssuedInvites(book, NOW).map((i) => i.jti)).toEqual(['two', 'one'])
    // The link, not just the id: an invitation you cannot re-share is only half remembered.
    expect(liveIssuedInvites(book, NOW)[1]?.link).toBe(first.link)
  })

  it('hides an expired invitation, which admits nobody and cannot usefully be revoked', () => {
    const book = rememberIssuedInvite(EMPTY_PERMIT_BOOK, invite('gone', NOW + 10), NOW)
    expect(liveIssuedInvites(book, NOW + 11)).toEqual([])
  })

  it('drops expired entries as it writes, so the record does not grow without bound', () => {
    const stale = rememberIssuedInvite(EMPTY_PERMIT_BOOK, invite('stale', NOW + 10), NOW)
    const book = rememberIssuedInvite(stale, invite('fresh', NOW + 1_000), NOW + 11)
    expect(book.issued?.map((i) => i.jti)).toEqual(['fresh'])
  })

  // ⚠️ The bound is expiry, never a count: evicting a live invitation would strand a working link
  // whose id is stored nowhere else.
  it('keeps every live invitation however many there are', () => {
    let book: DmPermitBook = EMPTY_PERMIT_BOOK
    for (let i = 0; i < 60; i++) book = rememberIssuedInvite(book, invite(`i${i}`, NOW + 1_000), NOW)
    expect(liveIssuedInvites(book, NOW)).toHaveLength(60)
  })

  it('replaces rather than duplicates when the same id is remembered twice', () => {
    const once = rememberIssuedInvite(EMPTY_PERMIT_BOOK, invite('same', NOW + 100), NOW)
    const twice = rememberIssuedInvite(once, invite('same', NOW + 900), NOW)
    expect(liveIssuedInvites(twice, NOW)).toHaveLength(1)
    expect(liveIssuedInvites(twice, NOW)[0]?.expiresAt).toBe(NOW + 900)
  })

  it('forgets one by id and leaves the rest', () => {
    const book = rememberIssuedInvite(
      rememberIssuedInvite(EMPTY_PERMIT_BOOK, invite('keep', NOW + 100), NOW),
      invite('drop', NOW + 100),
      NOW,
    )
    expect(liveIssuedInvites(forgetIssuedInvite(book, 'drop'), NOW).map((i) => i.jti)).toEqual(['keep'])
  })

  // A book written before invitations were kept has no `issued` field at all.
  it('reads a book from before this existed as having issued none', () => {
    const legacy = {held: {}, granted: {}, muted: []} as DmPermitBook
    expect(liveIssuedInvites(legacy, NOW)).toEqual([])
    expect(forgetIssuedInvite(legacy, 'anything').issued).toEqual([])
    expect(liveIssuedInvites(rememberIssuedInvite(legacy, invite('first', NOW + 100), NOW), NOW)).toHaveLength(1)
  })
})
