import {beforeEach, describe, expect, it, vi} from 'vitest'

const mocks = vi.hoisted(() => ({
  markAsRead: vi.fn(async (_id: number) => {}),
  update: vi.fn(async (_id: number, _patch: unknown) => {}),
  push: vi.fn(async (_e: unknown) => 0 as number | null),
}))

vi.mock('../services/notification-manager', () => ({
  pushNotificationManager: {events: {markAsRead: mocks.markAsRead, update: mocks.update, push: mocks.push}},
}))

import {type PushEvent, Trigger} from '../services/notification-types'
import {addNotif, CONTENT_DEDUP_WINDOW_MS} from './notifications.utils'

const BASE_MS = 1_700_000_000_000

const makeEvent = (overrides: Partial<PushEvent> = {}): PushEvent => ({
  id: 1,
  date: new Date(BASE_MS).toISOString(),
  isRead: false,
  title: 'Payment',
  body: '0.10 USD sent',
  data: {},
  trigger: Trigger.Push,
  ...overrides,
})

beforeEach(() => {
  mocks.markAsRead.mockClear()
  mocks.update.mockClear()
  mocks.push.mockClear()
  mocks.push.mockResolvedValue(0)
})

describe('addNotif', () => {
  it('byId match: marks read, no write, calls onFail', async () => {
    const onSuccess = vi.fn()
    const onFail = vi.fn()
    await addNotif({
      event: makeEvent({id: 42}),
      existingEvents: [makeEvent({id: 42})],
      isAndroid: false,
      onSuccess,
      onFail,
    })
    expect(mocks.markAsRead).toHaveBeenCalledWith(42)
    expect(mocks.update).not.toHaveBeenCalled()
    expect(mocks.push).not.toHaveBeenCalled()
    expect(onFail).toHaveBeenCalledTimes(1)
    expect(onSuccess).not.toHaveBeenCalled()
  })

  it('Android content match + uncategorized→categorized: enriches via update, calls onSuccess', async () => {
    const onSuccess = vi.fn()
    const onFail = vi.fn()
    const existing = makeEvent({id: 7, title: 'A', body: 'B', trigger: Trigger.Push})
    await addNotif({
      event: makeEvent({id: 999, title: 'A', body: 'B', trigger: Trigger.Transaction, data: {type: 'transaction'}}),
      existingEvents: [existing],
      isAndroid: true,
      onSuccess,
      onFail,
    })
    expect(mocks.markAsRead).toHaveBeenCalledWith(7)
    expect(mocks.update).toHaveBeenCalledWith(7, {data: {type: 'transaction'}, trigger: Trigger.Transaction})
    expect(mocks.push).not.toHaveBeenCalled()
    expect(onSuccess).toHaveBeenCalledTimes(1)
    expect(onFail).not.toHaveBeenCalled()
  })

  it('Android content match but already categorized: no write, calls onFail', async () => {
    const onSuccess = vi.fn()
    const onFail = vi.fn()
    const existing = makeEvent({id: 7, title: 'A', body: 'B', trigger: Trigger.Transaction})
    await addNotif({
      event: makeEvent({id: 999, title: 'A', body: 'B', trigger: Trigger.Transaction}),
      existingEvents: [existing],
      isAndroid: true,
      onSuccess,
      onFail,
    })
    expect(mocks.markAsRead).toHaveBeenCalledWith(7)
    expect(mocks.update).not.toHaveBeenCalled()
    expect(mocks.push).not.toHaveBeenCalled()
    expect(onFail).toHaveBeenCalledTimes(1)
    expect(onSuccess).not.toHaveBeenCalled()
  })

  it('does not content-match off Android — pushes as new', async () => {
    mocks.push.mockResolvedValue(55)
    const onSuccess = vi.fn()
    await addNotif({
      event: makeEvent({id: 999, title: 'A', body: 'B'}),
      existingEvents: [makeEvent({id: 7, title: 'A', body: 'B'})],
      isAndroid: false,
      onSuccess,
      onFail: vi.fn(),
    })
    expect(mocks.push).toHaveBeenCalledTimes(1)
    expect(mocks.markAsRead).toHaveBeenCalledWith(55)
    expect(onSuccess).toHaveBeenCalledTimes(1)
  })

  it('does not content-match outside the dedup window — pushes as new', async () => {
    const stale = makeEvent({id: 7, title: 'A', body: 'B', date: new Date(BASE_MS).toISOString()})
    await addNotif({
      event: makeEvent({
        id: 999,
        title: 'A',
        body: 'B',
        date: new Date(BASE_MS + CONTENT_DEDUP_WINDOW_MS).toISOString(),
      }),
      existingEvents: [stale],
      isAndroid: true,
      onSuccess: vi.fn(),
      onFail: vi.fn(),
    })
    expect(mocks.push).toHaveBeenCalledTimes(1)
  })

  it('new event: pushes, marks read with stored id, calls onSuccess', async () => {
    mocks.push.mockResolvedValue(123)
    const onSuccess = vi.fn()
    const onFail = vi.fn()
    await addNotif({
      event: makeEvent({id: 5}),
      existingEvents: [],
      isAndroid: true,
      onSuccess,
      onFail,
    })
    expect(mocks.push).toHaveBeenCalledTimes(1)
    expect(mocks.markAsRead).toHaveBeenCalledWith(123)
    expect(onSuccess).toHaveBeenCalledTimes(1)
    expect(onFail).not.toHaveBeenCalled()
  })

  it('new event with skipped push (null): marks read by event id, still calls onSuccess', async () => {
    mocks.push.mockResolvedValue(null)
    const onSuccess = vi.fn()
    await addNotif({
      event: makeEvent({id: 5}),
      existingEvents: [],
      isAndroid: true,
      onSuccess,
      onFail: vi.fn(),
    })
    expect(mocks.markAsRead).toHaveBeenCalledWith(5)
    expect(onSuccess).toHaveBeenCalledTimes(1)
  })

  it('callbacks are optional (no throw when omitted)', async () => {
    await expect(addNotif({event: makeEvent({id: 9}), existingEvents: [], isAndroid: false})).resolves.toBeUndefined()
    expect(mocks.push).toHaveBeenCalledTimes(1)
  })
})
