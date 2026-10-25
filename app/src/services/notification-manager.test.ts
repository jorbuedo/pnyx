import {beforeEach, describe, expect, it, vi} from 'vitest'

const mocks = vi.hoisted(() => {
  const storageState = new Map<string, string>()
  const platform = {os: 'ios' as 'ios' | 'android'}
  return {
    storageState,
    get platformOs() {
      return platform.os
    },
    set platformOs(value: 'ios' | 'android') {
      platform.os = value
    },
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

vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return mocks.platformOs
    },
  },
}))

const setBadgeCountMock = vi.fn(async (_n: number) => {})
vi.mock('../platform/notification-badge', () => ({
  setAppBadgeCount: (n: number) => setBadgeCountMock(n),
}))

import {pushNotificationManager} from './notification-manager'
import {defaultNotificationConfig, type PushEvent, Trigger} from './notification-types'

const CONFIG_KEY = 'push-notifications/config'
const SWEEP_KEY = 'push-notifications/sweep-history'

function makeEvent(overrides: Partial<PushEvent> = {}): PushEvent {
  return {
    id: 42,
    date: '2024-06-01T12:00:00.000Z',
    isRead: false,
    title: 'Payment',
    body: '0.10 USD sent',
    data: {},
    trigger: Trigger.Push,
    ...overrides,
  }
}

describe('pushNotificationManager.events.push contentless guard', () => {
  beforeEach(async () => {
    mocks.storageState.clear()
    mocks.platformOs = 'ios'
    mocks.storageState.set(CONFIG_KEY, JSON.stringify(defaultNotificationConfig))
    await pushNotificationManager.clear()
  })

  it('drops a contentless event (no title and no body) so it never reaches the inbox', async () => {
    const stored = await pushNotificationManager.events.push(makeEvent({id: 1, title: '', body: ''}))
    expect(stored).toBeNull()
    const events = await pushNotificationManager.events.read()
    expect(events).toHaveLength(0)
  })

  it('keeps an event that has a title but no body', async () => {
    const stored = await pushNotificationManager.events.push(makeEvent({id: 2, title: 'Heads up', body: ''}))
    expect(stored).toBe(2)
    expect(await pushNotificationManager.events.read()).toHaveLength(1)
  })

  it('keeps an event that has a body but no title', async () => {
    const stored = await pushNotificationManager.events.push(makeEvent({id: 3, title: '', body: 'You received 5 ADA'}))
    expect(stored).toBe(3)
    expect(await pushNotificationManager.events.read()).toHaveLength(1)
  })
})

describe('pushNotificationManager.events.push sweep history', () => {
  beforeEach(async () => {
    mocks.storageState.clear()
    mocks.platformOs = 'ios'
    mocks.storageState.set(CONFIG_KEY, JSON.stringify(defaultNotificationConfig))
    await pushNotificationManager.clear()
  })

  it('records id in sweep history on iOS after a successful push', async () => {
    const id = await pushNotificationManager.events.push(makeEvent({id: 100}))
    expect(id).toBe(100)
    const history = JSON.parse(mocks.storageState.get(SWEEP_KEY) ?? '[]') as string[]
    expect(history).toContain('100')
  })

  it('returns null on iOS when id is already in sweep history', async () => {
    await pushNotificationManager.events.push(makeEvent({id: 200}))
    const second = await pushNotificationManager.events.push(makeEvent({id: 200, title: 'Again'}))
    expect(second).toBeNull()
    const events = await pushNotificationManager.events.read()
    expect(events).toHaveLength(1)
  })

  it('records and reads sweep history on Android (foreground sweep needs the same backstop)', async () => {
    // The foreground sweep runs on Android too (force-stop / OEM-killer
    // backstop) — without a recorded history, the sweep would re-import
    // any row the user already removed from the inbox while the
    // notification was still visible in the system shade.
    mocks.platformOs = 'android'
    await pushNotificationManager.events.push(makeEvent({id: 300}))
    const second = await pushNotificationManager.events.push(makeEvent({id: 300, title: 'Again'}))
    expect(second).toBeNull()
    const history = JSON.parse(mocks.storageState.get(SWEEP_KEY) ?? '[]') as string[]
    expect(history).toContain('300')
  })

  it('records incoming id on content dedup without duplicating inbox rows', async () => {
    const first = makeEvent({id: 1, date: '2024-06-01T12:00:00.000Z'})
    const dup = makeEvent({id: 2, date: '2024-06-01T12:00:01.000Z'})
    await pushNotificationManager.events.push(first)
    const dedupedId = await pushNotificationManager.events.push(dup)
    expect(dedupedId).toBe(1)
    const events = await pushNotificationManager.events.read()
    expect(events).toHaveLength(1)
    const history = JSON.parse(mocks.storageState.get(SWEEP_KEY) ?? '[]') as string[]
    expect(history).toContain('2')
  })

  it('collapses the same Android push arriving via data-rich + data-poor paths despite different trigger', async () => {
    // Real-device regression: a backgrounded push lands twice — once via
    // the data-rich background handler / foreground onMessage (full payload →
    // Trigger.Transaction, messageId-hashed id) and once via the foreground
    // sweep reading the system-auto-displayed notification, whose data payload
    // is empty (Trigger.Push, date-hashed id). Same title+body, ~200ms apart,
    // but different id AND trigger — keying dedup on trigger let both rows in.
    mocks.platformOs = 'android'
    const dataRich = makeEvent({
      id: 1344933378,
      date: '2026-06-17T10:41:19.901Z',
      title: 'Transaction Approval Required',
      body: 'Approve your payment',
      trigger: Trigger.Transaction,
    })
    const sweepDegraded = makeEvent({
      id: 1701535291,
      date: '2026-06-17T10:41:20.111Z',
      title: 'Transaction Approval Required',
      body: 'Approve your payment',
      trigger: Trigger.Push,
    })
    await pushNotificationManager.events.push(dataRich)
    const dedupedId = await pushNotificationManager.events.push(sweepDegraded)
    expect(dedupedId).toBe(1344933378)
    const events = await pushNotificationManager.events.read()
    expect(events).toHaveLength(1)
    // The richer, correctly-classified row is the one that survives.
    expect(events[0]).toMatchObject({id: 1344933378, trigger: Trigger.Transaction})
  })

  it('upgrades a degraded sweep row in place when the data-rich push arrives second', async () => {
    // Reverse ordering of the above: the foreground sweep stores the empty-payload
    // Push row first, then the data-rich handler delivers the same notification with
    // a real trigger + data. Dedup keeps the first row's id/position but must enrich
    // its trigger/data so the inbox doesn't stay stuck on the degraded classification.
    mocks.platformOs = 'android'
    const sweepDegraded = makeEvent({
      id: 1701535291,
      date: '2026-06-17T10:41:20.111Z',
      title: 'Transaction Approval Required',
      body: 'Approve your payment',
      trigger: Trigger.Push,
      data: {},
    })
    const dataRich = makeEvent({
      id: 1344933378,
      date: '2026-06-17T10:41:19.901Z',
      title: 'Transaction Approval Required',
      body: 'Approve your payment',
      trigger: Trigger.Transaction,
      data: {type: 'transaction', hash: 'tx-1'},
    })
    await pushNotificationManager.events.push(sweepDegraded)
    const dedupedId = await pushNotificationManager.events.push(dataRich)
    // Kept row keeps the first id/position, but is upgraded with the real category.
    expect(dedupedId).toBe(1701535291)
    const events = await pushNotificationManager.events.read()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      id: 1701535291,
      trigger: Trigger.Transaction,
      data: {type: 'transaction', hash: 'tx-1'},
    })
  })

  it('iOS keeps the trigger in the dedup key (no empty-payload sweep split there)', async () => {
    // The Android empty-auto-display-payload split does not happen on iOS, so iOS
    // must retain the original trigger-sensitive match — two same-title/body pushes
    // with different triggers are distinct rows, not collapsed.
    mocks.platformOs = 'ios'
    const txEvent = makeEvent({
      id: 1,
      date: '2026-06-17T10:41:19.901Z',
      title: 'Transaction Approval Required',
      body: 'Approve your payment',
      trigger: Trigger.Transaction,
    })
    const push = makeEvent({
      id: 2,
      date: '2026-06-17T10:41:20.111Z',
      title: 'Transaction Approval Required',
      body: 'Approve your payment',
      trigger: Trigger.Push,
    })
    await pushNotificationManager.events.push(txEvent)
    const secondId = await pushNotificationManager.events.push(push)
    expect(secondId).toBe(2)
    expect(await pushNotificationManager.events.read()).toHaveLength(2)
  })
})

describe('pushNotificationManager.hydrate phantom row purge', () => {
  const EVENTS_KEY = 'push-notifications/events'

  beforeEach(async () => {
    mocks.storageState.clear()
    mocks.platformOs = 'ios'
    mocks.storageState.set(CONFIG_KEY, JSON.stringify(defaultNotificationConfig))
    setBadgeCountMock.mockClear()
    await pushNotificationManager.clear()
  })

  it('drops pre-#2248 contentless rows persisted in storage on hydrate', async () => {
    // Seed storage directly — events.push now rejects contentless rows,
    // so we simulate an inbox written by a buggy build.
    const seeded: PushEvent[] = [
      makeEvent({id: 1, title: 'Real', body: 'has content'}),
      makeEvent({id: 2, title: '', body: ''}),
      makeEvent({id: 3, title: 'Title only', body: ''}),
      makeEvent({id: 4, title: '', body: ''}),
    ]
    mocks.storageState.set(EVENTS_KEY, JSON.stringify(seeded))

    pushNotificationManager.hydrate()
    await new Promise((resolve) => setTimeout(resolve, 0))

    const events = await pushNotificationManager.events.read()
    expect(events.map((e) => e.id).sort()).toEqual([1, 3])
  })

  it('reconciles badge to non-phantom unread count after purge', async () => {
    const seeded: PushEvent[] = [
      makeEvent({id: 1, title: 'Real', body: 'has content'}),
      makeEvent({id: 2, title: '', body: ''}),
      makeEvent({id: 3, title: '', body: ''}),
    ]
    mocks.storageState.set(EVENTS_KEY, JSON.stringify(seeded))

    pushNotificationManager.hydrate()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(setBadgeCountMock).toHaveBeenLastCalledWith(1)
  })

  it('does not rewrite storage when no phantom rows present (no-op path)', async () => {
    const seeded: PushEvent[] = [makeEvent({id: 1, title: 'Real', body: 'has content'})]
    mocks.storageState.set(EVENTS_KEY, JSON.stringify(seeded))
    mocks.set.mockClear()

    pushNotificationManager.hydrate()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(mocks.set).not.toHaveBeenCalledWith(EVENTS_KEY, expect.any(String))
  })
})

describe('pushNotificationManager.clear', () => {
  beforeEach(async () => {
    mocks.storageState.clear()
    mocks.platformOs = 'ios'
    mocks.storageState.set(CONFIG_KEY, JSON.stringify(defaultNotificationConfig))
    await pushNotificationManager.clear()
  })

  it('clears sweep history', async () => {
    await pushNotificationManager.events.push(makeEvent({id: 77}))
    await pushNotificationManager.clear()
    expect(mocks.storageState.has(SWEEP_KEY)).toBe(false)
  })
})

describe('pushNotificationManager.events.update', () => {
  beforeEach(async () => {
    mocks.storageState.clear()
    mocks.platformOs = 'ios'
    mocks.storageState.set(CONFIG_KEY, JSON.stringify(defaultNotificationConfig))
    await pushNotificationManager.clear()
  })

  it('patches an existing event in place, preserving id, position, and read-state', async () => {
    await pushNotificationManager.events.push(makeEvent({id: 1, body: 'First', isRead: true, trigger: Trigger.Push}))
    await pushNotificationManager.events.push(makeEvent({id: 2, body: 'Second'}))

    await pushNotificationManager.events.update(1, {trigger: Trigger.Transaction, data: {type: 'transaction'}})

    const events = await pushNotificationManager.events.read()
    const updated = events.find((e) => e.id === 1)
    expect(updated).toMatchObject({
      id: 1,
      body: 'First',
      isRead: true,
      trigger: Trigger.Transaction,
      data: {type: 'transaction'},
    })
    // Order preserved (push prepends, so newest id 2 is first) — update does not reorder.
    expect(events.map((e) => e.id)).toEqual([2, 1])
  })

  it('is a no-op when the id is absent', async () => {
    await pushNotificationManager.events.push(makeEvent({id: 1}))
    await pushNotificationManager.events.update(999, {trigger: Trigger.Transaction})
    const events = await pushNotificationManager.events.read()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({id: 1, trigger: Trigger.Push})
  })
})

describe('pushNotificationManager badge sync', () => {
  beforeEach(async () => {
    mocks.storageState.clear()
    mocks.platformOs = 'ios'
    mocks.storageState.set(CONFIG_KEY, JSON.stringify(defaultNotificationConfig))
    setBadgeCountMock.mockClear()
    await pushNotificationManager.clear()
  })

  it('sets badge to total unread on push', async () => {
    await pushNotificationManager.events.push(makeEvent({id: 1}))
    await pushNotificationManager.events.push(makeEvent({id: 2, body: 'Other'}))
    expect(setBadgeCountMock).toHaveBeenLastCalledWith(2)
  })

  it('resets badge to 0 on markAllAsRead', async () => {
    await pushNotificationManager.events.push(makeEvent({id: 1}))
    setBadgeCountMock.mockClear()
    await pushNotificationManager.events.markAllAsRead()
    expect(setBadgeCountMock).toHaveBeenCalledWith(0)
  })

  it('resets badge to 0 on clear', async () => {
    await pushNotificationManager.events.push(makeEvent({id: 1}))
    setBadgeCountMock.mockClear()
    await pushNotificationManager.events.clear()
    expect(setBadgeCountMock).toHaveBeenCalledWith(0)
  })

  it('decrements badge on markAsRead', async () => {
    await pushNotificationManager.events.push(makeEvent({id: 1}))
    await pushNotificationManager.events.push(makeEvent({id: 2, body: 'Other'}))
    setBadgeCountMock.mockClear()
    await pushNotificationManager.events.markAsRead(1)
    expect(setBadgeCountMock).toHaveBeenLastCalledWith(1)
  })

  it('reconciles badge to persisted unread count on hydrate', async () => {
    await pushNotificationManager.events.push(makeEvent({id: 1}))
    await pushNotificationManager.events.push(makeEvent({id: 2, body: 'Other'}))
    setBadgeCountMock.mockClear()
    pushNotificationManager.hydrate()
    // hydrate calls updateUnreadCounter asynchronously; wait one tick
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(setBadgeCountMock).toHaveBeenLastCalledWith(2)
  })

  it('resyncs badge when KYC dedup collapses a push (count unchanged)', async () => {
    mocks.platformOs = 'android'
    await pushNotificationManager.events.push({
      id: 1,
      date: '2024-06-01T12:00:00.000Z',
      isRead: false,
      title: 'Verification Pending',
      body: 'body',
      data: {type: 'user', verificationStatus: 'Pending'},
      trigger: Trigger.Push,
    })
    setBadgeCountMock.mockClear()
    const result = await pushNotificationManager.events.push({
      id: 2,
      date: '2024-06-01T12:05:00.000Z',
      isRead: false,
      title: 'Verification In Progress',
      body: 'body',
      data: {type: 'user', verificationStatus: 'InReview'},
      trigger: Trigger.Push,
    })
    expect(result).toBe(1)
    expect(setBadgeCountMock).toHaveBeenLastCalledWith(1)
  })

  it('resyncs badge when 60s content-dedup collapses a push', async () => {
    mocks.platformOs = 'android'
    await pushNotificationManager.events.push(makeEvent({id: 1, date: '2024-06-01T12:00:00.000Z'}))
    setBadgeCountMock.mockClear()
    const result = await pushNotificationManager.events.push(makeEvent({id: 2, date: '2024-06-01T12:00:01.000Z'}))
    expect(result).toBe(1)
    expect(setBadgeCountMock).toHaveBeenLastCalledWith(1)
  })

  it('resyncs badge on isRead=true push (OS bumped, inbox count unchanged)', async () => {
    await pushNotificationManager.events.push(makeEvent({id: 1}))
    setBadgeCountMock.mockClear()
    await pushNotificationManager.events.push(makeEvent({id: 2, body: 'Read on arrival', isRead: true}))
    expect(setBadgeCountMock).toHaveBeenLastCalledWith(1)
  })
})

describe('pushNotificationManager concurrency', () => {
  beforeEach(async () => {
    mocks.storageState.clear()
    mocks.platformOs = 'android'
    mocks.storageState.set(CONFIG_KEY, JSON.stringify(defaultNotificationConfig))
    setBadgeCountMock.mockClear()
    await pushNotificationManager.clear()
  })

  it('serializes concurrent push() calls so neither write is lost', async () => {
    const [a, b, c] = await Promise.all([
      pushNotificationManager.events.push(makeEvent({id: 10, body: 'A'})),
      pushNotificationManager.events.push(makeEvent({id: 11, body: 'B'})),
      pushNotificationManager.events.push(makeEvent({id: 12, body: 'C'})),
    ])
    expect([a, b, c].sort()).toEqual([10, 11, 12])
    const events = await pushNotificationManager.events.read()
    const ids = events.map((e) => e.id).sort()
    expect(ids).toEqual([10, 11, 12])
  })

  it('serializes push vs markAllAsRead — push cannot overwrite the cleared state', async () => {
    await pushNotificationManager.events.push(makeEvent({id: 20}))
    await pushNotificationManager.events.push(makeEvent({id: 21, body: 'B'}))
    await Promise.all([
      pushNotificationManager.events.markAllAsRead(),
      pushNotificationManager.events.push(makeEvent({id: 22, body: 'C'})),
    ])
    const events = await pushNotificationManager.events.read()
    // Whatever order serialize resolves them in, the only possible final
    // states are (a) markAll first → push fires after, 22 unread + 20/21
    // read, or (b) push first → markAll clears all read. Both have
    // total inbox length 3.
    expect(events).toHaveLength(3)
    const unreadCount = events.filter((e) => !e.isRead).length
    expect(unreadCount === 0 || unreadCount === 1).toBe(true)
  })
})

describe('pushNotificationManager KYC dedup', () => {
  beforeEach(async () => {
    mocks.storageState.clear()
    // Pushes use distinct ids so sweep-history (id-keyed) never blocks
    // them, letting the KYC bucket dedup be observed in isolation.
    mocks.platformOs = 'android'
    mocks.storageState.set(CONFIG_KEY, JSON.stringify(defaultNotificationConfig))
    await pushNotificationManager.clear()
  })

  const userEvent = (overrides: {
    id: number
    date?: string
    verificationStatus?: string
    status?: string
    title?: string
  }): PushEvent =>
    makeEvent({
      id: overrides.id,
      ...(overrides.date ? {date: overrides.date} : {}),
      title: overrides.title ?? 'Verification',
      body: 'body',
      data: {
        type: 'user',
        ...(overrides.verificationStatus ? {verificationStatus: overrides.verificationStatus} : {}),
        ...(overrides.status ? {status: overrides.status} : {}),
      },
    })

  it('collapses two Applied (Submitted) pushes 10min apart to one inbox row', async () => {
    const first = userEvent({id: 1, date: '2024-06-01T12:00:00.000Z', verificationStatus: 'Applied'})
    const dup = userEvent({id: 2, date: '2024-06-01T12:10:00.000Z', verificationStatus: 'Applied'})
    await pushNotificationManager.events.push(first)
    const dedupedId = await pushNotificationManager.events.push(dup)
    expect(dedupedId).toBe(1)
    expect(await pushNotificationManager.events.read()).toHaveLength(1)
  })

  it('collapses Pending and InReview into a single "in-progress" row', async () => {
    const pending = userEvent({id: 1, date: '2024-06-01T12:00:00.000Z', verificationStatus: 'Pending'})
    const inReview = userEvent({
      id: 2,
      date: '2024-06-01T12:05:00.000Z',
      verificationStatus: 'InReview',
      title: 'Verification In Progress',
    })
    await pushNotificationManager.events.push(pending)
    const dedupedId = await pushNotificationManager.events.push(inReview)
    expect(dedupedId).toBe(1)
    expect(await pushNotificationManager.events.read()).toHaveLength(1)
  })

  it('does NOT collapse Applied vs Approved (different buckets)', async () => {
    await pushNotificationManager.events.push(
      userEvent({id: 1, date: '2024-06-01T12:00:00.000Z', verificationStatus: 'Applied'}),
    )
    const approvedId = await pushNotificationManager.events.push(
      userEvent({
        id: 2,
        date: '2024-06-01T12:30:00.000Z',
        verificationStatus: 'Approved',
        title: 'Verification Approved',
      }),
    )
    expect(approvedId).toBe(2)
    expect(await pushNotificationManager.events.read()).toHaveLength(2)
  })

  it('does NOT collapse two Applied pushes 25h apart (outside window)', async () => {
    await pushNotificationManager.events.push(
      userEvent({id: 1, date: '2024-06-01T12:00:00.000Z', verificationStatus: 'Applied'}),
    )
    const lateId = await pushNotificationManager.events.push(
      userEvent({id: 2, date: '2024-06-02T13:00:00.000Z', verificationStatus: 'Applied'}),
    )
    expect(lateId).toBe(2)
    expect(await pushNotificationManager.events.read()).toHaveLength(2)
  })

  it('refreshes kept row with latest title/body/data/date on dedup hit', async () => {
    await pushNotificationManager.events.push(
      userEvent({
        id: 1,
        date: '2024-06-01T12:00:00.000Z',
        verificationStatus: 'Pending',
        title: 'Verification Pending',
      }),
    )
    await pushNotificationManager.events.push(
      userEvent({
        id: 2,
        date: '2024-06-01T12:05:00.000Z',
        verificationStatus: 'InReview',
        title: 'Verification In Progress',
      }),
    )
    const events = await pushNotificationManager.events.read()
    expect(events).toHaveLength(1)
    expect(events[0]?.id).toBe(1)
    expect(events[0]?.title).toBe('Verification In Progress')
    expect(events[0]?.data).toMatchObject({verificationStatus: 'InReview'})
    expect(events[0]?.date).toBe('2024-06-01T12:05:00.000Z')
  })

  it('emits refreshed row on newEvents$ when KYC dedup hits', async () => {
    const listener = vi.fn()
    const unsubscribe = pushNotificationManager.newEvents$.subscribe(listener)
    try {
      await pushNotificationManager.events.push(
        userEvent({
          id: 1,
          date: '2024-06-01T12:00:00.000Z',
          verificationStatus: 'Pending',
          title: 'Verification Pending',
        }),
      )
      listener.mockClear()
      await pushNotificationManager.events.push(
        userEvent({
          id: 2,
          date: '2024-06-01T12:05:00.000Z',
          verificationStatus: 'InReview',
          title: 'Verification In Progress',
        }),
      )
      expect(listener).toHaveBeenCalledTimes(1)
      const emitted = listener.mock.calls[0]?.[0] as PushEvent | undefined
      expect(emitted?.id).toBe(1)
      expect(emitted?.title).toBe('Verification In Progress')
    } finally {
      unsubscribe()
    }
  })

  it('preserves isRead when refreshing kept row on dedup hit', async () => {
    await pushNotificationManager.events.push(
      userEvent({id: 1, date: '2024-06-01T12:00:00.000Z', verificationStatus: 'Pending'}),
    )
    await pushNotificationManager.events.markAsRead(1)
    await pushNotificationManager.events.push(
      userEvent({id: 2, date: '2024-06-01T12:05:00.000Z', verificationStatus: 'InReview'}),
    )
    const events = await pushNotificationManager.events.read()
    expect(events).toHaveLength(1)
    expect(events[0]?.isRead).toBe(true)
  })

  it('falls back to account status bucket when verificationStatus absent', async () => {
    await pushNotificationManager.events.push(userEvent({id: 1, date: '2024-06-01T12:00:00.000Z', status: 'Active'}))
    const dupId = await pushNotificationManager.events.push(
      userEvent({id: 2, date: '2024-06-01T12:05:00.000Z', status: 'Active'}),
    )
    expect(dupId).toBe(1)
    expect(await pushNotificationManager.events.read()).toHaveLength(1)
  })

  it('does not affect non-user (data.type!=user) pushes', async () => {
    const tx1 = makeEvent({
      id: 1,
      date: '2024-06-01T12:00:00.000Z',
      trigger: Trigger.Transaction,
      data: {type: 'transaction'},
    })
    const tx2 = makeEvent({
      id: 2,
      date: '2024-06-01T12:05:00.000Z',
      trigger: Trigger.Transaction,
      title: 'Other',
      data: {type: 'transaction'},
    })
    await pushNotificationManager.events.push(tx1)
    const secondId = await pushNotificationManager.events.push(tx2)
    expect(secondId).toBe(2)
    expect(await pushNotificationManager.events.read()).toHaveLength(2)
  })
})
