import {beforeEach, describe, expect, it, vi} from 'vitest'

const mocks = vi.hoisted(() => {
  const storageState = new Map<string, string>()
  const platform = {os: 'ios' as 'ios' | 'android'}
  const foregroundListeners: Array<(event: {type: number; detail: unknown}) => void> = []
  const backgroundListeners: Array<(event: {type: number; detail: unknown}) => Promise<void>> = []

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
    handlePushNavigation: vi.fn(),
    displayedNotifications: [] as Array<{id?: string; date?: string; notification: {id?: string}}>,
    createChannel: vi.fn(),
    getDisplayedNotifications: vi.fn(async () => mocks.displayedNotifications),
    foregroundListeners,
    backgroundListeners,
    onForegroundEvent: vi.fn((cb: (event: {type: number; detail: unknown}) => void) => {
      foregroundListeners.push(cb)
    }),
    onBackgroundEvent: vi.fn((cb: (event: {type: number; detail: unknown}) => Promise<void>) => {
      backgroundListeners.push(cb)
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

vi.mock('../logger', () => ({
  logger: {warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn()},
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
    createChannel: mocks.createChannel,
    getDisplayedNotifications: mocks.getDisplayedNotifications,
    onForegroundEvent: mocks.onForegroundEvent,
    onBackgroundEvent: mocks.onBackgroundEvent,
  },
  AndroidImportance: {HIGH: 4},
  EventType: {PRESS: 1, ACTION_PRESS: 2},
}))

// Mock the entire notification-tools module to avoid pulling in
// @react-native-firebase/messaging and card-partner SDKs (native modules
// that Vitest can't parse without their own test transform).
vi.mock('./notification-tools', () => ({
  handlePushNavigation: mocks.handlePushNavigation,
}))

vi.mock('./detect', () => ({
  get platformIsAndroid() {
    return mocks.platformOs === 'android'
  },
  isNative: true,
}))

import {pushNotificationManager} from '../services/notification-manager'
import {defaultNotificationConfig, idFromString, Trigger} from '../services/notification-types'
import {registerNotifeeHandlers} from './notifee-setup'

const CONFIG_KEY = 'push-notifications/config'
const PRESS = 1

function makeDetail(messageId: string, dataOverrides: Record<string, unknown> = {}) {
  return {
    notification: {
      id: messageId,
      title: 'Approve transaction',
      body: 'Tap to approve',
      data: dataOverrides,
      remote: {messageId},
    },
  }
}

async function fireForegroundPress(detail: unknown): Promise<void> {
  for (const listener of mocks.foregroundListeners) {
    listener({type: PRESS, detail})
  }
  // Flush microtasks so the async press handler completes
  await new Promise((resolve) => setTimeout(resolve, 0))
}

async function fireBackgroundPress(detail: unknown): Promise<void> {
  for (const listener of mocks.backgroundListeners) {
    await listener({type: PRESS, detail})
  }
}

describe('registerNotifeeHandlers — tap-from-notification-center', () => {
  beforeEach(async () => {
    mocks.storageState.clear()
    mocks.platformOs = 'ios'
    mocks.foregroundListeners.length = 0
    mocks.backgroundListeners.length = 0
    mocks.displayedNotifications = []
    vi.clearAllMocks()
    mocks.storageState.set(CONFIG_KEY, JSON.stringify(defaultNotificationConfig))
    await pushNotificationManager.clear()
    registerNotifeeHandlers()
  })

  it('adds the tapped notification to the inbox when it was not previously there (iOS foreground)', async () => {
    await fireForegroundPress(makeDetail('msg-approve-1'))

    const events = await pushNotificationManager.events.read()
    expect(events).toHaveLength(1)
    expect(events[0]?.id).toBe(idFromString('msg-approve-1'))
    expect(events[0]?.title).toBe('Approve transaction')
  })

  it('marks the tapped notification as read immediately (iOS foreground)', async () => {
    await fireForegroundPress(makeDetail('msg-approve-2'))

    const events = await pushNotificationManager.events.read()
    expect(events[0]?.isRead).toBe(true)
  })

  it('adds and marks read via background event handler', async () => {
    await fireBackgroundPress(makeDetail('msg-complete-1'))

    const events = await pushNotificationManager.events.read()
    expect(events).toHaveLength(1)
    expect(events[0]?.id).toBe(idFromString('msg-complete-1'))
    expect(events[0]?.isRead).toBe(true)
  })

  it('deduplicates and marks read when background handler already added it (Android path)', async () => {
    // Simulate Android background handler having pushed the notification first (unread)
    const existingId = idFromString('msg-android-1')
    await pushNotificationManager.events.push({
      id: existingId,
      date: '2024-06-01T10:00:00.000Z',
      isRead: false,
      title: 'Approve transaction',
      body: 'Tap to approve',
      data: {},
      trigger: Trigger.Push,
    })

    await fireForegroundPress(makeDetail('msg-android-1'))

    const events = await pushNotificationManager.events.read()
    // Still only one event (deduplicated by id)
    expect(events).toHaveLength(1)
    expect(events[0]?.id).toBe(existingId)
    expect(events[0]?.isRead).toBe(true)
  })

  it('resolves id from notification.id when remote.messageId is absent', async () => {
    const detail = {
      notification: {
        id: 'notif-only-id',
        title: 'Complete',
        body: 'Transaction complete',
        data: {},
        // no remote field
      },
    }

    await fireForegroundPress(detail)

    const events = await pushNotificationManager.events.read()
    expect(events).toHaveLength(1)
    expect(events[0]?.id).toBe(idFromString('notif-only-id'))
  })

  it('uses remote.sentTime for delivery date when available', async () => {
    const sentTimeMs = 1717228800000 // 2024-06-01T12:00:00.000Z
    const detail = {
      notification: {
        id: 'msg-remote-sent-time',
        title: 'Complete',
        body: 'done',
        data: {},
        remote: {messageId: 'msg-remote-sent-time', sentTime: sentTimeMs},
      },
    }

    await fireForegroundPress(detail)

    const events = await pushNotificationManager.events.read()
    expect(events[0]?.date).toBe(new Date(sentTimeMs).toISOString())
  })

  it('falls back to google.sent_time when remote.sentTime is absent', async () => {
    const sentTimeMs = 1717228800000 // 2024-06-01T12:00:00.000Z
    const detail = {
      notification: {
        id: 'msg-sent-time',
        title: 'Complete',
        body: 'done',
        data: {'google.sent_time': sentTimeMs},
        remote: {messageId: 'msg-sent-time'},
      },
    }

    await fireForegroundPress(detail)

    const events = await pushNotificationManager.events.read()
    expect(events[0]?.date).toBe(new Date(sentTimeMs).toISOString())
  })

  it('classifies a transaction payload as the Transaction trigger', async () => {
    const detail = {
      notification: {
        id: 'msg-tx-1',
        title: 'Sent',
        body: 'Your transaction was submitted',
        data: {type: 'transaction', hash: 'tx-abc'},
        remote: {messageId: 'msg-tx-1'},
      },
    }

    await fireForegroundPress(detail)

    const events = await pushNotificationManager.events.read()
    expect(events[0]?.trigger).toBe(Trigger.Transaction)
  })

  it('does not create duplicate inbox rows when tapped twice', async () => {
    const detail = makeDetail('msg-double-tap')
    await fireForegroundPress(detail)
    await fireForegroundPress(detail)

    const events = await pushNotificationManager.events.read()
    expect(events).toHaveLength(1)
  })

  it('calls handlePushNavigation with the notification data', async () => {
    await fireForegroundPress(makeDetail('msg-nav-1'))

    expect(mocks.handlePushNavigation).toHaveBeenCalledOnce()
  })
})
