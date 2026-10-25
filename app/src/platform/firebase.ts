/**
 * Firebase Cloud Messaging initialization.
 *
 * Handles FCM subscription, foreground message display via Notifee,
 * and direct navigation for background/cold-start notification taps.
 */

import notifee, {AndroidImportance} from '@notifee/react-native'
import {
  AuthorizationStatus,
  type FirebaseMessagingTypes,
  getInitialNotification,
  getMessaging,
  hasPermission,
  isDeviceRegisteredForRemoteMessages,
  onMessage,
  onNotificationOpenedApp,
  onTokenRefresh,
  registerDeviceForRemoteMessages,
  subscribeToTopic,
  unsubscribeFromTopic,
} from '@react-native-firebase/messaging'
import {InteractionManager} from 'react-native'
import {logger} from '../logger'
import {pushNotificationManager} from '../services/notification-manager'
import {notificationPrefs} from '../services/notification-storage'
import type {PushEvent} from '../services/notification-types'
import {
  idFromString,
  isLocallyReconciled,
  parseScreenTarget,
  TRANSACTION_SCREENS,
  Trigger,
  triggerForKind,
} from '../services/notification-types'
import {platformIsAndroid} from './detect'
import {resolveFcmDeliveryMs} from './fcm-delivery-time'
import {FCM_CAMPAIGNS_FROM, FCM_CAMPAIGNS_TOPIC, getFCMToken} from './fcm-token'
import {NOTIFEE_CHANNEL_ID} from './notifee-setup'
import {NOTIFICATION_SMALL_ICON} from './notification-channel'
import {handlePushNavigation, registerDeviceToken} from './notification-tools'
import {addNotif} from './notifications.utils'

/** Subscribe to FCM token rotation. Returns the unsubscribe function. */
export function onFcmTokenRefresh(listener: (token: string) => void): () => void {
  return onTokenRefresh(getMessaging(), listener)
}

function deriveTrigger(remoteMessage: FirebaseMessagingTypes.RemoteMessage, data: Record<string, unknown>): Trigger {
  // The kind is the most specific thing a payload carries, and the only one a per-category setting
  // can act on — so it outranks the heuristics below.
  const byKind = triggerForKind(data)
  if (byKind !== undefined) return byKind
  if (remoteMessage.from === FCM_CAMPAIGNS_FROM) return Trigger.Campaigns
  if (typeof data.screen === 'string' && TRANSACTION_SCREENS.has(data.screen)) return Trigger.Transaction
  if (data.type === 'transaction') return Trigger.Transaction
  return Trigger.Push
}

function createEventFromRemoteMessage(remoteMessage: FirebaseMessagingTypes.RemoteMessage): PushEvent {
  const data = (remoteMessage.data ?? {}) as Record<string, unknown>
  return {
    id: idFromString(remoteMessage.messageId),
    date: new Date(resolveFcmDeliveryMs(remoteMessage.sentTime, data['google.sent_time']) ?? Date.now()).toISOString(),
    isRead: false,
    title: remoteMessage.notification?.title ?? '',
    body: remoteMessage.notification?.body ?? '',
    data,
    trigger: deriveTrigger(remoteMessage, data),
  }
}

async function registerFirebaseIfPermissionsGranted(
  messagingInstance: FirebaseMessagingTypes.Module,
): Promise<boolean> {
  const status = await hasPermission(messagingInstance)
  logger.debug('FCM permission status', {origin: 'push-notifications/firebase', status})
  if (status !== AuthorizationStatus.AUTHORIZED && status !== AuthorizationStatus.PROVISIONAL) {
    // Not an error — the user may simply have declined — but it decides whether this device can ever
    // receive a push, so it must not be the one thing that happens silently.
    logger.debug('FCM registration skipped: notifications are not authorised', {
      origin: 'push-notifications/firebase',
      status,
    })
    return false
  }

  if (!isDeviceRegisteredForRemoteMessages(messagingInstance)) {
    await registerDeviceForRemoteMessages(messagingInstance)
  }

  const config = await pushNotificationManager.config.read()
  if (config[Trigger.Campaigns].notify) {
    /**
     * ⚠️ **Never awaited.** Topic subscription is an optional broadcast channel — nothing in this repo
     * publishes to it — and it used to gate the return, so this device's whole push rail hung behind
     * it: the emulator's Play services answered `Failed to sync topics. Won't retry sync.
     * INVALID_PARAMETERS`, the promise never settled, and `registerDeviceToken()` — the only thing
     * that fetches a *fresh* FCM token — never ran. The app then went on registering a stale stored
     * token that FCM rejects as UNREGISTERED, so every push was dropped.
     *
     * A device that cannot join a topic must still be able to receive its own notifications.
     */
    void subscribeToTopic(messagingInstance, FCM_CAMPAIGNS_TOPIC)
      .then(() => {
        logger.debug('Subscribed to FCM topic', {origin: 'push-notifications/firebase', topic: FCM_CAMPAIGNS_TOPIC})
      })
      .catch((error: unknown) => {
        logger.warn('could not subscribe to the campaigns topic; per-device pushes are unaffected', {
          origin: 'push-notifications/firebase',
          topic: FCM_CAMPAIGNS_TOPIC,
          error: String(error),
        })
      })
  }
  return true
}

async function handleForegroundMessage(remoteMessage: FirebaseMessagingTypes.RemoteMessage): Promise<void> {
  const kind = remoteMessage.data?.kind
  if (isLocallyReconciled(remoteMessage.data)) {
    logger.debug('foreground push dropped: the socket owns this kind while the app is open', {
      origin: 'push-notifications/firebase',
      kind,
    })
    return
  }
  const event = createEventFromRemoteMessage(remoteMessage)

  const storedId = await pushNotificationManager.events.push(event)
  if (storedId == null) return

  // Pin the displayed notification's id to the FCM messageId so the
  // iOS foreground sweep can recover the same identifier later via
  // `displayed.notification.id` (notifee strips `notification.remote`
  // for manually-displayed notifications, so this is the only field
  // that survives). When the sweep hashes it through djb2 it gets the
  // same numeric event id we already stored, and id-based dedup
  // catches the duplicate — no fuzzy content matching required.
  await notifee.displayNotification({
    ...(remoteMessage.messageId ? {id: remoteMessage.messageId} : {}),
    title: event.title || undefined,
    body: event.body || undefined,
    android: {
      channelId: NOTIFEE_CHANNEL_ID,
      smallIcon: NOTIFICATION_SMALL_ICON,
      importance: AndroidImportance.HIGH,
      pressAction: {id: 'default'},
    },
    ios: {
      foregroundPresentationOptions: {
        banner: true,
        sound: true,
        badge: true,
      },
    },
    data: {...(event.data as Record<string, string>), id: String(storedId), trigger: event.trigger},
  })
}

export function initFirebasePushNotifications(): () => void {
  logger.debug('FCM init entered', {origin: 'push-notifications/firebase'})
  const messagingInstance = getMessaging()
  let isUnmounted = false
  let isSubscribed = false

  let foregroundUnsubscribe: (() => void) | undefined
  let openedAppUnsubscribe: (() => void) | undefined
  let tokenRefreshUnsubscribe: (() => void) | undefined

  const init = async () => {
    try {
      if (isUnmounted) return

      isSubscribed = await registerFirebaseIfPermissionsGranted(messagingInstance).catch((e) => {
        logger.error('Firebase registration failed', {origin: 'push-notifications/firebase', cause: e})
        return false
      })

      if (isUnmounted) return

      logger.debug('FCM init', {origin: 'push-notifications/firebase', isSubscribed})
      if (isSubscribed) {
        registerDeviceToken().catch((e) => {
          logger.warn('Failed to register the device token; this device gets no pushes', {
            origin: 'push-notifications/firebase',
            error: String(e),
          })
        })
      }

      foregroundUnsubscribe = onMessage(messagingInstance, (remoteMessage) => {
        handleForegroundMessage(remoteMessage).catch((e) => {
          logger.error('Failed to handle foreground FCM message', {origin: 'push-notifications/firebase', cause: e})
        })
      })

      // Background tap — JS thread alive, navigator in memory, navigate directly.
      openedAppUnsubscribe = onNotificationOpenedApp(messagingInstance, async (remoteMessage) => {
        logger.info('[push] onNotificationOpenedApp', {
          origin: 'push-notifications/firebase',
          messageId: remoteMessage.messageId,
          dataKeys: Object.keys(remoteMessage.data ?? {}),
        })
        const event = createEventFromRemoteMessage(remoteMessage)

        // A tap always navigates — on both the write path (`onSuccess`: new push
        // or category-enrich) and the already-present path (`onFail`).
        const navigate = () =>
          handlePushNavigation({...event.data, trigger: event.trigger}, parseScreenTarget(event.data.screen))
        // ⚠️ Navigate, but do not store: the app owns this kind's row and rebuilds it from unread
        // state. Storing here put the push's own "New message" back into the centre *because* the
        // user opened the conversation — reading it was what made it reappear.
        if (isLocallyReconciled(remoteMessage.data)) {
          navigate()
          return
        }
        const existingEvents = await pushNotificationManager.events.read()
        await addNotif({
          event,
          existingEvents,
          isAndroid: platformIsAndroid,
          onSuccess: navigate,
          onFail: navigate,
        })
      })

      tokenRefreshUnsubscribe = onTokenRefresh(messagingInstance, (newToken) => {
        logger.debug('FCM token refreshed', {origin: 'push-notifications/firebase'})
        notificationPrefs.fcmToken.set(newToken).catch((e) => {
          logger.warn('Failed to persist the refreshed FCM token', {
            origin: 'push-notifications/firebase',
            error: String(e),
          })
        })
      })

      // Cold start — wait for layout then navigate.
      getInitialNotification(messagingInstance)
        .then(async (remoteMessage) => {
          if (!remoteMessage || isUnmounted) return
          logger.info('[push] getInitialNotification resolved', {
            origin: 'push-notifications/firebase',
            messageId: remoteMessage.messageId,
            dataKeys: Object.keys(remoteMessage.data ?? {}),
          })
          const event = createEventFromRemoteMessage(remoteMessage)
          const goTo = () =>
            InteractionManager.runAfterInteractions(() => {
              handlePushNavigation({...event.data, trigger: event.trigger}, parseScreenTarget(event.data.screen))
            })
          // Same as the background tap: the row is the app's to build, the navigation is the push's.
          if (isLocallyReconciled(remoteMessage.data)) {
            goTo()
            return
          }
          const existingEvents = await pushNotificationManager.events.read()
          await addNotif({
            event,
            existingEvents,
            isAndroid: platformIsAndroid,
            onSuccess: () => {
              InteractionManager.runAfterInteractions(() => {
                handlePushNavigation({...event.data, trigger: event.trigger}, parseScreenTarget(event.data.screen))
              })
            },
            onFail: () => {
              InteractionManager.runAfterInteractions(() => {
                handlePushNavigation({...event.data, trigger: event.trigger}, parseScreenTarget(event.data.screen))
              })
            },
          })
        })
        .catch((e) => {
          logger.error('Failed to handle initial notification', {origin: 'push-notifications/firebase', cause: e})
        })

      logger.debug('Firebase push notifications initialized', {origin: 'push-notifications/firebase'})
    } catch (e) {
      logger.error('Firebase push notifications init failed', {origin: 'push-notifications/firebase', cause: e})
    }
  }

  init()

  return () => {
    isUnmounted = true
    foregroundUnsubscribe?.()
    openedAppUnsubscribe?.()
    tokenRefreshUnsubscribe?.()
    if (isSubscribed) {
      unsubscribeFromTopic(messagingInstance, FCM_CAMPAIGNS_TOPIC).catch((e) => {
        // Non-fatal on teardown, but a device left subscribed keeps receiving campaigns.
        logger.warn('Failed to unsubscribe from the campaigns topic', {
          origin: 'push-notifications/firebase',
          error: String(e),
        })
      })
    }
  }
}

// Re-exported from where they have always been imported; they are defined in `fcm-token.ts`, which
// nothing in this module's dependency chain imports back. See that module for the cycle it breaks.
export {FCM_CAMPAIGNS_TOPIC, getFCMToken}
