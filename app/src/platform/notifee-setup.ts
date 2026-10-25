/**
 * Notifee channel setup and global event handlers.
 */

import notifee, {AndroidImportance, type EventDetail, EventType} from '@notifee/react-native'
import {pushNotificationManager} from '../services/notification-manager'
import {idFromString, parseScreenTarget} from '../services/notification-types'
import {platformIsAndroid} from './detect'
import {resolveFcmDeliveryMs} from './fcm-delivery-time'
import {NOTIFEE_CHANNEL_ID, NOTIFEE_DM_CHANNEL_ID} from './notification-channel'
import {deriveSweptTrigger} from './notification-sweep-pure'
import {handlePushNavigation} from './notification-tools'
import {addNotif} from './notifications.utils'

// Re-exported from where it has always been imported; it lives in `notification-channel.ts` so the
// prebuild plugin's test can read it without pulling in the native module.
export {NOTIFEE_CHANNEL_ID, NOTIFEE_DM_CHANNEL_ID} from './notification-channel'

/**
 * Creates the Android notification channel.
 */
export async function setupNotifee(): Promise<void> {
  if (!platformIsAndroid) return
  await notifee.createChannel({
    id: NOTIFEE_CHANNEL_ID,
    name: 'Push Notifications',
    importance: AndroidImportance.HIGH,
    sound: 'default',
    vibration: true,
  })
  // Its own channel so an OS-drawn DM is still identifiable once its data is gone — see
  // `NOTIFEE_DM_CHANNEL_ID`. The service sends DMs with `channel_id` set to this.
  await notifee.createChannel({
    id: NOTIFEE_DM_CHANNEL_ID,
    name: 'Direct messages',
    importance: AndroidImportance.HIGH,
    sound: 'default',
    vibration: true,
  })
}

async function handleNotificationPress(detail: EventDetail): Promise<void> {
  const notif = detail.notification
  const data = (notif?.data ?? {}) as Record<string, unknown>

  handlePushNavigation(data, parseScreenTarget(data.screen))

  // Same djb2 hash as the background handler and sweep — consistent id space
  // across all entry points so markAsRead targets the correct inbox row.
  const remote = (notif as {remote?: {messageId?: string; sentTime?: number}} | undefined)?.remote
  const stableId = idFromString(remote?.messageId ?? notif?.id)

  // Delivery date priority: remote.sentTime (Firebase ms) → google.sent_time (FCM data ms) → now.
  // The shared floor rejects the Android Int32-clamped sentTime (≈1970-01-25) and
  // seconds-based values so a tapped notification doesn't surface a 1970 date.
  // getDisplayedNotifications() is not useful here — iOS clears the notification from the center
  // on tap before any async call can capture it.
  const resolvedSentMs = resolveFcmDeliveryMs(remote?.sentTime, data['google.sent_time'])
  const date = new Date(resolvedSentMs ?? Date.now()).toISOString()

  const title = notif?.title ?? ''
  const body = notif?.body ?? ''

  // Reconcile the press against the inbox (mark-read / enrich an existing row,
  // or store a new one). Navigation already happened above, so no callbacks.
  // `isRead: true` — the user is acting on it; addNotif marks read after a push.
  // On iOS the background handler never fires for notification-type payloads and
  // tapping dismisses the banner before the sweep can capture it, so this is the
  // only inbox entry-point for that path; on Android the background handler
  // already stored it and addNotif dedups by id / content.
  const existingEvents = await pushNotificationManager.events.read()
  await addNotif({
    event: {
      id: stableId,
      date,
      isRead: true,
      title,
      body,
      data,
      trigger: deriveSweptTrigger(data),
    },
    existingEvents,
    isAndroid: platformIsAndroid,
  })
}

/**
 * Registers global Notifee foreground and background event handlers.
 * Must be called once during app init (outside React render).
 */
export function registerNotifeeHandlers(): void {
  notifee.onForegroundEvent(({type, detail}) => {
    if (type === EventType.PRESS || type === EventType.ACTION_PRESS) {
      void handleNotificationPress(detail)
    }
  })

  notifee.onBackgroundEvent(async ({type, detail}) => {
    if (type === EventType.PRESS || type === EventType.ACTION_PRESS) {
      await handleNotificationPress(detail)
    }
  })
}
