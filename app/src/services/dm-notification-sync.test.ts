/**
 * The DM half of the notification centre: what the reconciliation writes, and what the user's
 * setting stops it writing.
 */

import {beforeEach, describe, expect, it, vi} from 'vitest'
import type {UnreadConversation} from './dm-notification-rows'
import {defaultNotificationConfig, Trigger} from './notification-types'

vi.mock('../logger', () => ({logger: {debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn()}}))

type StoredEvent = {
  id: number
  date: string
  isRead: boolean
  title: string
  body: string
  data: Record<string, unknown>
  trigger: Trigger
}

/** A stand-in notification store: the rows, and the config the sync reads before touching them. */
const h = vi.hoisted(() => ({
  rows: [] as StoredEvent[],
  notify: true,
}))

vi.mock('./notification-manager', () => ({
  pushNotificationManager: {
    config: {read: async () => ({...defaultNotificationConfig, [Trigger.DirectMessage]: {notify: h.notify}})},
    events: {
      read: async () => h.rows,
      push: async (event: StoredEvent) => {
        h.rows.push(event)
        return event.id
      },
      update: async (id: number, patch: Partial<StoredEvent>) => {
        h.rows = h.rows.map((row) => (row.id === id ? {...row, ...patch} : row))
      },
      remove: async (id: number) => {
        h.rows = h.rows.filter((row) => row.id !== id)
      },
    },
  },
}))

const {syncDmNotificationRows} = await import('./dm-notification-sync')

const unread = (convId: string, label: string): UnreadConversation => ({
  convId,
  label,
  lastMessageAt: '2026-08-31T10:00:00.000Z',
})

const sync = (conversations: readonly UnreadConversation[]) =>
  syncDmNotificationRows(conversations, (peer) => `Message from ${peer}`, 'Tap to read')

beforeEach(() => {
  h.rows = []
  h.notify = true
})

describe('syncDmNotificationRows', () => {
  it('writes one named row per unread conversation, under the DM category', async () => {
    await sync([unread('c1', 'alice'), unread('c2', 'bob')])
    expect(h.rows.map((r) => r.title)).toEqual(['Message from alice', 'Message from bob'])
    expect(h.rows.every((r) => r.trigger === Trigger.DirectMessage)).toBe(true)
  })

  // The row is what the setting governs. The unread dots in the DM inbox are derived from read
  // markers and are deliberately untouched by it.
  it('writes nothing while the user has DM notifications off', async () => {
    h.notify = false
    await sync([unread('c1', 'alice')])
    expect(h.rows).toEqual([])
  })

  // Switching it off has to clear what was written while it was on, or the centre keeps rows the
  // setting says should not be there until the conversation is read.
  it('clears rows written before it was switched off', async () => {
    await sync([unread('c1', 'alice')])
    expect(h.rows).toHaveLength(1)

    h.notify = false
    await sync([unread('c1', 'alice')])
    expect(h.rows).toEqual([])
  })

  it('is idempotent while it is on', async () => {
    await sync([unread('c1', 'alice')])
    const first = [...h.rows]
    await sync([unread('c1', 'alice')])
    expect(h.rows).toEqual(first)
  })
})
