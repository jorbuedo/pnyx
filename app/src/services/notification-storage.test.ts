import {beforeEach, describe, expect, it, vi} from 'vitest'

const mocks = vi.hoisted(() => {
  const storageState = new Map<string, string>()
  return {
    storageState,
    get: vi.fn(async (key: string) => mocks.storageState.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      mocks.storageState.set(key, value)
    }),
    remove: vi.fn(async (key: string) => {
      mocks.storageState.delete(key)
    }),
  }
})

vi.mock('../platform/storage', () => ({
  storage: {
    get: mocks.get,
    set: mocks.set,
    remove: mocks.remove,
  },
}))

import {eventsStorage, sweepHistoryStorage} from './notification-storage'
import type {PushEvent} from './notification-types'
import {Trigger} from './notification-types'

const SWEEP_KEY = 'push-notifications/sweep-history'
const EVENTS_KEY = 'push-notifications/events'

function makeEvent(id: number): PushEvent {
  return {
    id,
    date: '2024-06-01T12:00:00.000Z',
    isRead: false,
    title: 't',
    body: 'b',
    data: {},
    trigger: Trigger.Push,
  }
}

describe('sweepHistoryStorage', () => {
  beforeEach(() => {
    mocks.storageState.clear()
    vi.clearAllMocks()
  })

  it('starts empty', async () => {
    expect(await sweepHistoryStorage.read()).toEqual(new Set())
  })

  it('deduplicates ids on add', async () => {
    await sweepHistoryStorage.add([1, '1', 2])
    expect(await sweepHistoryStorage.read()).toEqual(new Set(['1', '2']))
    const raw = mocks.storageState.get(SWEEP_KEY)
    expect(raw).toBe(JSON.stringify(['1', '2']))
  })

  it('ignores non-array persisted JSON', async () => {
    mocks.storageState.set(SWEEP_KEY, JSON.stringify({1: true, 2: true}))
    expect(await sweepHistoryStorage.read()).toEqual(new Set())
  })

  it('FIFO-caps at 500 entries', async () => {
    const ids = Array.from({length: 501}, (_, i) => String(i))
    await sweepHistoryStorage.add(ids)
    const stored = JSON.parse(mocks.storageState.get(SWEEP_KEY) ?? '[]') as string[]
    expect(stored).toHaveLength(500)
    expect(stored[0]).toBe('1')
    expect(stored[499]).toBe('500')
  })

  it('clear removes sweep history', async () => {
    await sweepHistoryStorage.add([42])
    await sweepHistoryStorage.clear()
    expect(mocks.storageState.has(SWEEP_KEY)).toBe(false)
  })
})

describe('eventsStorage', () => {
  beforeEach(() => {
    mocks.storageState.clear()
  })

  it('caps inbox at 100 events', async () => {
    const events = Array.from({length: 120}, (_, i) => makeEvent(i))
    await eventsStorage.write(events)
    const stored = JSON.parse(mocks.storageState.get(EVENTS_KEY) ?? '[]') as PushEvent[]
    expect(stored).toHaveLength(100)
    expect(stored[0]?.id).toBe(0)
    expect(stored[99]?.id).toBe(99)
  })
})
