import {beforeEach, describe, expect, it, vi} from 'vitest'

const mocks = vi.hoisted(() => {
  const storageState = new Map<string, string>()
  const getDisplayed: () => Promise<unknown[]> = async () => []
  const platform = {os: 'ios' as 'ios' | 'android'}
  const sweepDelayMs = 0
  return {
    storageState,
    getDisplayed,
    get platformOs() {
      return platform.os
    },
    set platformOs(value: 'ios' | 'android') {
      platform.os = value
    },
    sweepDelayMs,
    get: vi.fn(async (key: string) => mocks.storageState.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      mocks.storageState.set(key, value)
    }),
    remove: vi.fn(async (key: string) => {
      mocks.storageState.delete(key)
    }),
    warn: vi.fn(),
    info: vi.fn(),
    getDisplayedNotifications: vi.fn(async () => mocks.getDisplayed()),
  }
})

vi.mock('../platform/storage', () => ({
  storage: {
    get: mocks.get,
    set: mocks.set,
    remove: mocks.remove,
  },
}))

vi.mock('../logger', () => ({
  logger: {warn: mocks.warn, info: mocks.info},
}))

vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return mocks.platformOs
    },
  },
}))

vi.mock('@notifee/react-native', () => ({
  default: {
    getDisplayedNotifications: mocks.getDisplayedNotifications,
  },
}))

import {pushNotificationManager} from '../services/notification-manager'
import {defaultNotificationConfig, idFromString, Trigger} from '../services/notification-types'
import {sweepDisplayedNotifications} from './notification-sweep'

const CONFIG_KEY = 'push-notifications/config'

function displayed(messageId: string, date: string) {
  return {
    id: messageId,
    date,
    notification: {
      id: messageId,
      title: 'Tx',
      body: '0.10 USD',
      data: {},
      remote: {messageId},
    },
  }
}

describe('sweepDisplayedNotifications', () => {
  beforeEach(async () => {
    mocks.storageState.clear()
    mocks.platformOs = 'ios'
    mocks.sweepDelayMs = 0
    mocks.getDisplayed = async () => []
    vi.clearAllMocks()
    mocks.storageState.set(CONFIG_KEY, JSON.stringify(defaultNotificationConfig))
    await pushNotificationManager.clear()
  })

  it('also runs on Android (backstop for force-stopped / OEM-killed apps)', async () => {
    // `setBackgroundMessageHandler` is the primary path on Android but
    // doesn't fire after Force-stop and is unreliable on aggressive
    // OEM background killers. The sweep is the safety net — running it
    // on Android imports rows the headless handler missed. Dedup in
    // `events.push` collapses overlap with rows the handler did store.
    mocks.platformOs = 'android'
    mocks.getDisplayed = async () => [displayed('m1', '2024-06-01T12:00:00.000Z')]
    await sweepDisplayedNotifications()
    expect(mocks.getDisplayedNotifications).toHaveBeenCalledTimes(1)
  })

  it('no-ops on web (no notifee bridge)', async () => {
    mocks.platformOs = 'web' as 'ios' | 'android'
    mocks.getDisplayed = async () => [displayed('m1', '2024-06-01T12:00:00.000Z')]
    await sweepDisplayedNotifications()
    expect(mocks.getDisplayedNotifications).not.toHaveBeenCalled()
  })

  it('imports displayed notifications not in sweep history', async () => {
    mocks.getDisplayed = async () => [displayed('msg-a', '2024-06-01T10:00:00.000Z')]
    await sweepDisplayedNotifications()
    const events = await pushNotificationManager.events.read()
    expect(events).toHaveLength(1)
    expect(events[0]?.id).toBe(idFromString('msg-a'))
  })

  it('skips rows already in sweep history', async () => {
    await pushNotificationManager.events.push({
      id: idFromString('msg-b'),
      date: '2024-06-01T10:00:00.000Z',
      isRead: false,
      title: 'Tx',
      body: '0.10 USD',
      data: {},
      trigger: Trigger.Push,
    })
    mocks.getDisplayed = async () => [displayed('msg-b', '2024-06-01T11:00:00.000Z')]
    await sweepDisplayedNotifications()
    expect(await pushNotificationManager.events.read()).toHaveLength(1)
  })

  it('coalesces concurrent sweeps onto one in-flight run', async () => {
    let resolveDisplayed!: () => void
    mocks.getDisplayed = () =>
      new Promise((resolve) => {
        resolveDisplayed = () => resolve([displayed('msg-c', '2024-06-01T12:00:00.000Z')])
      })

    const first = sweepDisplayedNotifications()
    const second = sweepDisplayedNotifications()
    resolveDisplayed()
    await Promise.all([first, second])

    expect(mocks.getDisplayedNotifications).toHaveBeenCalledTimes(1)
  })

  it('logs and skips notifications without delivery time', async () => {
    mocks.getDisplayed = async () => [
      {
        id: 'no-date',
        notification: {id: 'no-date', title: 'Tx', body: 'x', data: {}, remote: {messageId: 'no-date'}},
      },
    ]
    await sweepDisplayedNotifications()
    expect(await pushNotificationManager.events.read()).toHaveLength(0)
    expect(mocks.warn).toHaveBeenCalled()
  })

  it('prepends in delivery order without a trailing full-inbox rewrite', async () => {
    await pushNotificationManager.events.push({
      id: 999,
      date: '2024-06-02T12:00:00.000Z',
      isRead: false,
      title: 'Existing',
      body: 'inbox',
      data: {},
      trigger: Trigger.Push,
    })

    mocks.getDisplayed = async () => [
      displayed('newer', '2024-06-01T14:00:00.000Z'),
      displayed('older', '2024-06-01T10:00:00.000Z'),
    ]
    await sweepDisplayedNotifications()

    const events = await pushNotificationManager.events.read()
    expect(events.map((e) => e.id)).toEqual([idFromString('newer'), idFromString('older'), 999])
    expect(events[0]?.date).toBe('2024-06-01T14:00:00.000Z')
  })
})
