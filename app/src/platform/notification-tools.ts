/**
 * Push notification utilities.
 *
 * Permission prompting, navigation from notification data,
 * FCM device token registration, and the useRequestSystemNotifications hook.
 *
 */

import notifee, {AuthorizationStatus as NotifeeAuthorizationStatus} from '@notifee/react-native'
import {
  AuthorizationStatus,
  getMessaging,
  hasPermission,
  isDeviceRegisteredForRemoteMessages,
  registerDeviceForRemoteMessages,
  requestPermission,
  subscribeToTopic,
  unsubscribeFromTopic,
} from '@react-native-firebase/messaging'
import {useEffect} from 'react'
import {PermissionsAndroid, Platform} from 'react-native'
import {logger} from '../logger'
import {configStorage, notificationPrefs} from '../services/notification-storage'
import {Trigger} from '../services/notification-types'
import {FCM_CAMPAIGNS_TOPIC, getFCMToken} from './fcm-token'

export {handlePushNavigation} from './notification-navigation'

export async function subscribeToUserTopic(userId: string): Promise<void> {
  try {
    const messaging = getMessaging()
    if (!isDeviceRegisteredForRemoteMessages(messaging)) {
      await registerDeviceForRemoteMessages(messaging)
    }
    await notificationPrefs.userId.set(userId)
    await subscribeToTopic(messaging, `user_${userId}`)
  } catch (e) {
    logger.error('Failed to subscribe to user FCM topic', {origin: 'push-notifications/tools', cause: e})
  }
}

export async function unsubscribeFromUserTopic(): Promise<void> {
  try {
    const userId = await notificationPrefs.userId.get()
    if (!userId) return
    await unsubscribeFromTopic(getMessaging(), `user_${userId}`)
    await notificationPrefs.userId.remove()
  } catch (e) {
    logger.error('Failed to unsubscribe from user FCM topic', {origin: 'push-notifications/tools', cause: e})
  }
}

/**
 * Unsubscribe the FCM user-topic owned by a specific wallet group.
 *
 * FCM subscriptions are device-wide and keyed by userId, NOT by groupId — two
 * groups (e.g. a re-imported mnemonic, or two derivations of the same partner
 * identity) can share one userId. Dropping the topic on every group-remove
 * would silence pushes for a remaining group that still depends on it.
 *
 * So: always drop this group's per-group entry, but only unsubscribe the FCM
 * topic when no OTHER group still maps to the same userId. `notificationPrefs.
 * userId` (the global "currently subscribed" key) is cleared on the same
 * condition — preserves an unrelated wallet's live subscription.
 */
export async function unsubscribeUserTopicForGroup(groupId: string): Promise<void> {
  // Per-group user-topic bookkeeping was keyed by the (removed) card wallet
  // storage; without it, group removal is a no-op — the device-wide topic is
  // dropped by unsubscribeFromUserTopic when the last wallet goes.
  logger.debug('unsubscribeUserTopicForGroup: no per-group topic bookkeeping in this shell', {
    origin: 'push-notifications/tools',
    groupId,
  })
}

export async function subscribeToCampaignsTopic(): Promise<void> {
  try {
    const messaging = getMessaging()
    if (!isDeviceRegisteredForRemoteMessages(messaging)) {
      await registerDeviceForRemoteMessages(messaging)
    }
    await subscribeToTopic(messaging, FCM_CAMPAIGNS_TOPIC)
  } catch (e) {
    logger.error('Failed to subscribe to campaigns FCM topic', {origin: 'push-notifications/tools', cause: e})
  }
}

export async function unsubscribeFromCampaignsTopic(): Promise<void> {
  try {
    await unsubscribeFromTopic(getMessaging(), FCM_CAMPAIGNS_TOPIC)
  } catch (e) {
    logger.error('Failed to unsubscribe from campaigns FCM topic', {origin: 'push-notifications/tools', cause: e})
  }
}

const isAuthorized = (status: number): boolean =>
  status === AuthorizationStatus.AUTHORIZED || status === AuthorizationStatus.PROVISIONAL

/** Whether OS-level push permission is currently granted. */
export async function hasNotificationsPermission(): Promise<boolean> {
  const messaging = getMessaging()
  const status = await hasPermission(messaging)
  if (!isAuthorized(status)) return false
  if (Platform.OS === 'android') {
    if (Platform.Version >= 33) {
      return PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS)
    }
    // POST_NOTIFICATIONS doesn't exist below API 33 — notifications are on by default
    // but users can still disable them via system settings. Notifee checks that.
    const settings = await notifee.getNotificationSettings()
    return settings.authorizationStatus === NotifeeAuthorizationStatus.AUTHORIZED
  }
  return true
}

/** Prompt the OS for push permission and return whether it was granted. */
export async function requestNotificationsPermission(): Promise<boolean> {
  await triggerNotificationsPermissionModal()
  return hasNotificationsPermission()
}

export async function triggerNotificationsPermissionModal(): Promise<void> {
  const messaging = getMessaging()
  const existing = await hasPermission(messaging)
  let granted = isAuthorized(existing)

  if (!granted) {
    const requested = await requestPermission(messaging)
    granted = isAuthorized(requested)
  }

  if (granted && Platform.OS === 'android' && Platform.Version >= 33) {
    const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS)
    if (result !== PermissionsAndroid.RESULTS.GRANTED) granted = false
  }

  if (granted) {
    try {
      if (!isDeviceRegisteredForRemoteMessages(messaging)) {
        await registerDeviceForRemoteMessages(messaging)
      }
      const config = await configStorage.read()
      if (config[Trigger.Campaigns].notify) {
        await subscribeToTopic(messaging, FCM_CAMPAIGNS_TOPIC)
      }
      await notifee.requestPermission({sound: true, announcement: true, badge: true, alert: true})
    } catch (e) {
      logger.error('Push registration after permission failed', {origin: 'push-notifications/tools', cause: e})
    }
  }

  await notificationPrefs.permissionPrompted.set(true)
}

export async function getNotificationsAuthorizationStatus(): Promise<'authorized' | 'denied' | 'not_determined'> {
  const status = await hasPermission(getMessaging())
  const alreadyPrompted = await notificationPrefs.permissionPrompted.get()

  if (isAuthorized(status)) {
    if (Platform.OS === 'android') {
      if (Platform.Version >= 33) {
        const androidGranted = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS)
        if (!androidGranted) return 'denied'
      } else {
        // POST_NOTIFICATIONS doesn't exist below API 33 — check via notifee instead
        const settings = await notifee.getNotificationSettings()
        if (settings.authorizationStatus !== NotifeeAuthorizationStatus.AUTHORIZED) return 'denied'
      }
    }
    return 'authorized'
  }

  if (status === AuthorizationStatus.DENIED) return 'denied'

  if (!alreadyPrompted) return 'not_determined'

  return 'denied'
}

export async function registerDeviceToken(): Promise<void> {
  try {
    const messagingInstance = getMessaging()
    if (!isDeviceRegisteredForRemoteMessages(messagingInstance)) {
      await registerDeviceForRemoteMessages(messagingInstance)
    }
    const token = await getFCMToken()
    if (!token) {
      // ⚠️ Silent until 2026-08-31, and it hid a real outage: with no fresh token the app goes on
      // registering whatever is *stored*, which may be a token from a previous Firebase project. The
      // service then gets UNREGISTERED from FCM, prunes the row as a dead install, and the device is
      // never told — so every push is dropped and nothing anywhere says so.
      logger.warn('no FCM token available, so this device keeps whatever it registered before', {
        origin: 'push-notifications/tools',
      })
      return
    }
    await notificationPrefs.fcmToken.set(token)
    // Backend registration (POST /devices) needs the session JWT, which does not
    // exist here — the session flow owns it (providers/use-device-registration.ts).
    logger.debug('FCM token stored for backend registration', {origin: 'push-notifications/tools'})
  } catch (e) {
    logger.error('Failed to register device token', {origin: 'push-notifications/tools', cause: e})
  }
}

const PROMPT_DELAY_MS = 1000

export function useRequestSystemNotifications({enabled}: {enabled: boolean}): void {
  useEffect(() => {
    if (!enabled) return

    const timeout = setTimeout(async () => {
      const alreadyPrompted = await notificationPrefs.permissionPrompted.get()
      if (!alreadyPrompted) {
        await triggerNotificationsPermissionModal()
      }
    }, PROMPT_DELAY_MS)

    return () => clearTimeout(timeout)
  }, [enabled])
}
