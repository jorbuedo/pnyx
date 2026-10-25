import {describe, expect, it} from 'vitest'
import {isUnread, newlyArrived, unreadConversations} from './dm-unread'

const conv = (convId: string, lastMessageAt: string) => ({convId, lastMessageAt})

describe('isUnread', () => {
  it('treats a conversation never opened on this device as unread', () => {
    // Over-reporting attention is recoverable; hiding a message is not.
    expect(isUnread('2026-08-31T10:00:00.000Z', undefined)).toBe(true)
  })

  it('is read when the marker is at or past the last message', () => {
    expect(isUnread('2026-08-31T10:00:00.000Z', '2026-08-31T10:00:00.000Z')).toBe(false)
    expect(isUnread('2026-08-31T10:00:00.000Z', '2026-08-31T10:00:01.000Z')).toBe(false)
  })

  it('is unread when a message landed after the marker', () => {
    expect(isUnread('2026-08-31T10:00:01.000Z', '2026-08-31T10:00:00.000Z')).toBe(true)
  })
})

describe('unreadConversations', () => {
  it('selects only the conversations with something new', () => {
    const list = [
      conv('a', '2026-08-31T10:00:00.000Z'),
      conv('b', '2026-08-31T09:00:00.000Z'),
      conv('c', '2026-08-31T11:00:00.000Z'),
    ]
    const markers = new Map([
      ['a', '2026-08-31T10:00:00.000Z'],
      ['b', '2026-08-31T08:00:00.000Z'],
    ])
    expect(unreadConversations(list, markers)).toEqual(['b', 'c'])
  })

  it('is empty when everything has been read', () => {
    const list = [conv('a', '2026-08-31T10:00:00.000Z')]
    expect(unreadConversations(list, new Map([['a', '2026-08-31T10:00:00.000Z']]))).toEqual([])
  })
})

describe('newlyArrived', () => {
  it('says nothing on the first reading, so a backlog is not announced at startup', () => {
    expect(newlyArrived(undefined, [conv('a', '2026-08-31T10:00:00.000Z')])).toEqual([])
  })

  it('reports a conversation whose last message moved', () => {
    const before = [conv('a', '2026-08-31T10:00:00.000Z')]
    const after = [conv('a', '2026-08-31T10:05:00.000Z')]
    expect(newlyArrived(before, after)).toEqual(['a'])
  })

  it('reports a conversation that did not exist before', () => {
    expect(newlyArrived([], [conv('new', '2026-08-31T10:00:00.000Z')])).toEqual(['new'])
  })

  it('says nothing about a conversation that is merely still unread', () => {
    // It already has a dot. Repeating it on every refetch would toast on a timer.
    const same = [conv('a', '2026-08-31T10:00:00.000Z')]
    expect(newlyArrived(same, same)).toEqual([])
  })

  it('ignores a conversation that disappeared', () => {
    expect(newlyArrived([conv('gone', '2026-08-31T10:00:00.000Z')], [])).toEqual([])
  })
})
