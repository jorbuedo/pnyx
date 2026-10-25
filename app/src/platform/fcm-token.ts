/**
 * The FCM device token and the campaigns topic — the two things about Firebase that a caller needs
 * without needing Firebase's message handling.
 *
 * ⚠️ **Its own module to break a require cycle, and the cycle was not harmless.** `firebase.ts` must
 * import `handlePushNavigation` and `registerDeviceToken` from `notification-tools.ts` (a tap has to
 * reach a screen), while `notification-tools.ts` only wanted these two values back — so the two
 * modules imported each other, and `notifee-setup.ts` closed a second loop through the same pair.
 * Metro reports exactly what is at stake: "Require cycles are allowed, but can result in uninitialized
 * values." Both modules load during app boot, which is where an `undefined` import actually bites.
 *
 * Nothing here imports either of them, so the dependency now runs one way.
 *
 * @module
 */

import {
  deleteToken,
  getMessaging,
  getToken,
  isDeviceRegisteredForRemoteMessages,
  registerDeviceForRemoteMessages,
} from '@react-native-firebase/messaging'
import Constants from 'expo-constants'
import {logger} from '../logger'

const isDev = Constants.expoConfig?.extra?.isDevelopment === true

/** The topic broadcast campaigns are published to, kept apart per environment. */
export const FCM_CAMPAIGNS_TOPIC = isDev ? 'pnyx-campaigns-dev' : 'pnyx-campaigns'

/** The `from` field FCM stamps on a message delivered through {@link FCM_CAMPAIGNS_TOPIC}. */
export const FCM_CAMPAIGNS_FROM = `/topics/${FCM_CAMPAIGNS_TOPIC}`

/** This device's FCM token, registering for remote messages first if it has not been. */
export async function getFCMToken(): Promise<string | null> {
  try {
    const messaging = getMessaging()
    if (!isDeviceRegisteredForRemoteMessages(messaging)) {
      await registerDeviceForRemoteMessages(messaging)
    }
    return await getToken(messaging)
  } catch (e) {
    logger.warn('Failed to get FCM token', {origin: 'push-notifications/fcm-token', cause: e})
    return null
  }
}

/**
 * Throw this device's FCM token away and mint a new one.
 *
 * ⚠️ **`getToken()` alone cannot do this.** Play services caches the token against the Firebase
 * installation id, and an install-over keeps that id — so a token minted under a *previous* project
 * config survives every rebuild and comes back byte-identical. The server then answers `UNREGISTERED`
 * for it while broadcasts to the same app arrive perfectly, which is what made this look like a
 * delivery problem rather than a stale-token one.
 *
 * Only a real uninstall or this call rotates it. Exposed for the dev screen because the alternative
 * costs the device's whole identity.
 */
export async function rotateFcmToken(): Promise<string | null> {
  try {
    const messaging = getMessaging()
    await deleteToken(messaging)
    if (!isDeviceRegisteredForRemoteMessages(messaging)) {
      await registerDeviceForRemoteMessages(messaging)
    }
    const fresh = await getToken(messaging)
    logger.info('FCM token rotated', {origin: 'push-notifications/fcm-token', prefix: fresh.slice(0, 12)})
    return fresh
  } catch (e) {
    logger.warn('Failed to rotate the FCM token', {origin: 'push-notifications/fcm-token', cause: e})
    return null
  }
}
