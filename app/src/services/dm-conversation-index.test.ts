/**
 * The merge rule behind a client-owned inbox. What matters is that the server half is treated as a
 * *queue of what is waiting* rather than as a second opinion about who you talk to — because once
 * delivered ciphertext is deleted, a settled conversation has no server row at all.
 */

import {describe, expect, it} from 'vitest'
import {
  type DmConversation,
  mergeServerPending,
  sortConversations,
  unreadConvIds,
  upsertConversation,
} from './dm-conversation-index'

const conv = (convId: string, peer: string, lastMessageAt: string): DmConversation => ({convId, peer, lastMessageAt})

describe('upsertConversation', () => {
  it('adds one it has never seen', () => {
    expect(upsertConversation([], conv('c1', 'alice', '2026-09-01T10:00:00.000Z'))).toEqual([
      conv('c1', 'alice', '2026-09-01T10:00:00.000Z'),
    ])
  })

  // ⚠️ A late write about an older message must not drag the marker back and re-light a dot the
  // user already cleared.
  it('never moves lastMessageAt backwards', () => {
    const list = [conv('c1', 'alice', '2026-09-01T12:00:00.000Z')]
    const after = upsertConversation(list, conv('c1', 'alice', '2026-09-01T09:00:00.000Z'))
    expect(after[0]?.lastMessageAt).toBe('2026-09-01T12:00:00.000Z')
  })

  it('moves it forward when the news is newer', () => {
    const list = [conv('c1', 'alice', '2026-09-01T09:00:00.000Z')]
    const after = upsertConversation(list, conv('c1', '', '2026-09-01T12:00:00.000Z'))
    expect(after[0]?.lastMessageAt).toBe('2026-09-01T12:00:00.000Z')
  })

  // A `touch` from the receive path knows the id but may not know the party; blanking the peer would
  // make the thread unrepliable, since sending refuses without one.
  it('keeps the known peer when the update carries none', () => {
    const list = [conv('c1', 'alice', '2026-09-01T09:00:00.000Z')]
    expect(upsertConversation(list, conv('c1', '', '2026-09-01T12:00:00.000Z'))[0]?.peer).toBe('alice')
  })

  it('learns the peer when it did not have one', () => {
    const list = [conv('c1', '', '2026-09-01T09:00:00.000Z')]
    expect(upsertConversation(list, conv('c1', 'alice', '2026-09-01T09:00:00.000Z'))[0]?.peer).toBe('alice')
  })
})

describe('mergeServerPending', () => {
  // The whole point: a conversation with nothing undelivered is absent server-side and must survive.
  it('keeps a conversation the server no longer lists', () => {
    const local = [conv('settled', 'alice', '2026-09-01T09:00:00.000Z')]
    expect(mergeServerPending(local, [])).toEqual(local)
  })

  // A restored device has no index yet; the queue is the only place a conversation can come from.
  it('adopts a conversation this device has never heard of', () => {
    const merged = mergeServerPending([], [conv('c2', 'bob', '2026-09-01T11:00:00.000Z')])
    expect(merged).toEqual([conv('c2', 'bob', '2026-09-01T11:00:00.000Z')])
  })

  // ⚠️ Undelivered means unread. If the local write won here, a queued message would read as
  // already seen the moment the index was touched for any other reason.
  it('lets a newer pending message win over the local marker', () => {
    const local = [conv('c1', 'alice', '2026-09-01T09:00:00.000Z')]
    const merged = mergeServerPending(local, [conv('c1', 'alice', '2026-09-01T12:00:00.000Z')])
    expect(merged[0]?.lastMessageAt).toBe('2026-09-01T12:00:00.000Z')
  })
})

describe('sortConversations', () => {
  it('is newest first, and total so equal rows cannot reshuffle', () => {
    const a = conv('aaa', 'x', '2026-09-01T10:00:00.000Z')
    const b = conv('bbb', 'y', '2026-09-01T10:00:00.000Z')
    const c = conv('ccc', 'z', '2026-09-01T11:00:00.000Z')
    expect(sortConversations([a, b, c]).map((one) => one.convId)).toEqual(['ccc', 'aaa', 'bbb'])
    expect(sortConversations([b, c, a]).map((one) => one.convId)).toEqual(['ccc', 'aaa', 'bbb'])
  })
})

describe('unreadConvIds', () => {
  it('counts one never opened as unread', () => {
    const list = [conv('c1', 'alice', '2026-09-01T10:00:00.000Z')]
    expect(unreadConvIds(list, new Map())).toEqual(['c1'])
  })

  it('clears one read up to its newest message', () => {
    const list = [conv('c1', 'alice', '2026-09-01T10:00:00.000Z')]
    expect(unreadConvIds(list, new Map([['c1', '2026-09-01T10:00:00.000Z']]))).toEqual([])
  })

  it('re-lights one whose newest message is past the marker', () => {
    const list = [conv('c1', 'alice', '2026-09-01T12:00:00.000Z')]
    expect(unreadConvIds(list, new Map([['c1', '2026-09-01T10:00:00.000Z']]))).toEqual(['c1'])
  })
})
