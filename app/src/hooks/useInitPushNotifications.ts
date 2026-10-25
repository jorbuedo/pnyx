/**
 * Push notification initialization hook.
 */

import {useEffect} from 'react'
import {AppState, Platform} from 'react-native'
import {logger} from '../logger'
import {isNative} from '../platform'
import {initFirebasePushNotifications} from '../platform/firebase'
import {registerNotifeeHandlers, setupNotifee} from '../platform/notifee-setup'
import {sweepDisplayedNotifications} from '../platform/notification-sweep'
import {pushNotificationManager} from '../services/notification-manager'
import {useFeatureFlag} from './useFeatureFlag'

export function useInitPushNotifications(): void {
  const pushNotificationsEnabled = useFeatureFlag('pushNotifications')

  useEffect(() => {
    if (!isNative || !pushNotificationsEnabled) {
      // The one branch that decides whether this device can receive a push at all, and it used to
      // take it silently — so "push is set up" and "push never started" looked identical.
      logger.debug('push init skipped', {
        origin: 'useInitPushNotifications',
        isNative,
        pushNotificationsEnabled,
      })
      return
    }
    let mounted = true
    let cleanup: (() => void) | undefined

    // Recompute the unread counter from persisted events so the OS badge
    // is reconciled with the in-app inbox on every launch. Without this,
    // the badge can stay at a stale value from the previous session
    // (or whatever APNs/FCM last set) until the next push, mark, or
    // clear action runs through `updateUnreadCounter`.
    pushNotificationManager.hydrate()

    // Channel must exist before Firebase starts — notifee silently drops
    // notifications on Android if the channel isn't created yet.
    // Firebase init proceeds regardless of setupNotifee outcome because
    // FCM registration and listeners must work even if channel creation fails
    // (e.g. on iOS where Android channels are a no-op).
    // ⚠️ This and the line below bracket a native call that has been seen to never settle. Without
    // both, a hung `createChannel` is indistinguishable from push having started normally.
    logger.debug('push init starting', {origin: 'useInitPushNotifications'})
    setupNotifee()
      .then(() => {
        logger.debug('push init: the notification channel is ready', {origin: 'useInitPushNotifications'})
        if (!mounted) return
        registerNotifeeHandlers()
        cleanup = initFirebasePushNotifications()
      })
      .catch((e) => {
        if (!mounted) return
        logger.warn('Notifee setup failed, proceeding with Firebase init', {
          origin: 'useInitPushNotifications',
          cause: e,
        })
        registerNotifeeHandlers()
        cleanup = initFirebasePushNotifications()
      })

    return () => {
      mounted = false
      cleanup?.()
    }
  }, [pushNotificationsEnabled])

  // Per-user FCM topic subscription was card-account bound; forum-event
  // topics land here in a later phase (see docs/mobile-shell-plan.md phase 4).

  // Sweep the OS notification center for pushes that arrived while the JS
  // runtime was dormant — the background-message handler in index.js can miss
  // them: on iOS for plain `notification` payloads (APNs displays them
  // directly), on Android after force-stop / on aggressive OEM killers.
  //
  // The initial mount sweep covers cold start (killed → active). The AppState
  // listener re-sweeps on every background → active transition on both iOS and
  // Android: on Android the background-message handler in index.js does not
  // reliably fire while the app is backgrounded, so we can't rely on it for the
  // warm path — sweeping each time the app becomes active closes that gap.
  useEffect(() => {
    if (!isNative || !pushNotificationsEnabled || Platform.OS === 'web') return

    void sweepDisplayedNotifications()

    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void sweepDisplayedNotifications()
    })

    return () => {
      subscription.remove()
    }
  }, [pushNotificationsEnabled])
}
