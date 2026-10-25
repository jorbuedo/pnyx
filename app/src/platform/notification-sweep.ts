/**
 * Foreground sweep of the OS notification shade → in-app inbox.
 *
 * Why this exists:
 *
 * iOS — When the app is backgrounded and a push arrives, APNs displays
 * the banner without giving the JS thread a chance to run, *unless* the
 * payload carries `aps.content-available: 1` (silent-push wake). The
 * current backend pushes pure-notification payloads, so iOS shows the
 * banner but `setBackgroundMessageHandler` (in `index.js`) never fires.
 * If the user then opens the app via the app icon (instead of tapping
 * the banner), neither `onNotificationOpenedApp` nor
 * `getInitialNotification` fires either — so the notification never
 * lands in our inbox.
 *
 * Android — `setBackgroundMessageHandler` normally populates the inbox,
 * but it does not fire when the app has been force-stopped (via Settings
 * → Force stop) and is unreliable on OEMs that aggressively kill
 * background JS contexts (Xiaomi MIUI, Huawei EMUI, Samsung's adaptive
 * battery on some firmwares, swipe-away on stock launchers). In those
 * cases the system still displays the banner but our headless handler
 * never runs, and the notification is missing from the inbox when the
 * user opens the app. Running the same sweep there imports those rows.
 *
 * On both platforms we ask Notifee for the list of currently-displayed
 * notifications on every transition to foreground and import any we
 * don't already have. Notifications the user already dismissed from
 * the lockscreen / shade are gone — neither OS exposes them — so this
 * isn't a 100% backstop, only a covering of the common "unread sitting
 * in notification shade, user taps app icon" path.
 *
 * Dedup is handled by `pushNotificationManager.events.push` (id-level +
 * content-level within a 60s window), so re-imports from the sweep
 * after the headless handler already stored a row (Android) or after a
 * later `onNotificationOpenedApp` tap (both platforms) collapse onto a
 * single row.
 *
 * @module
 */

import notifee from '@notifee/react-native'
import {Platform} from 'react-native'

import {logger} from '../logger'
import {pushNotificationManager} from '../services/notification-manager'
import {sweepHistoryStorage} from '../services/notification-storage'
import {isLocallyReconciled} from '../services/notification-types'
import {NOTIFEE_DM_CHANNEL_ID} from './notification-channel'
import {eventFromDisplayed, sortDisplayedForImport} from './notification-sweep-pure'

let sweepInFlight: Promise<void> | null = null

/**
 * Read the OS notification shade and import any displayed notifications
 * that aren't already in the inbox. Safe to call repeatedly —
 * concurrent callers share one in-flight sweep, and the pre-push guard
 * plus the manager's own dedup collapse re-imports onto a single row.
 *
 * Web has no notifee bridge — short-circuit there. iOS + Android both run.
 */
/** The Android channel a displayed notification was posted on, when it says. */
const channelOf = (item: {notification?: {android?: {channelId?: string}}}): string | undefined =>
  item.notification?.android?.channelId

export async function sweepDisplayedNotifications(): Promise<void> {
  if (Platform.OS === 'web') return
  if (sweepInFlight) return sweepInFlight

  sweepInFlight = runSweep().finally(() => {
    sweepInFlight = null
  })
  return sweepInFlight
}

async function runSweep(): Promise<void> {
  try {
    const displayed = await notifee.getDisplayedNotifications()
    if (displayed.length === 0) return

    const sweepHistory = await sweepHistoryStorage.read()
    const sweptThisCall = new Set<number>()
    // Captured once so sort + event resolution share the same now-fallback
    // timestamp. Different `Date.now()` between sort and the per-item
    // resolve would reorder items in the comparator vs the import loop.
    const ordered = sortDisplayedForImport(displayed)

    const events = await pushNotificationManager.events.read()

    for (const item of ordered) {
      // Android's FCM service emits a synthetic "group summary" StatusBarNotification
      // (`group: "g:Aggregate_AlertingSection"`) with neither title nor body whenever
      // 2+ pushes stack — skip those so the inbox doesn't import a blank row.
      if (!item.notification.title && !item.notification.body && Platform.OS === 'android') continue
      const data = item.notification.data as Record<string, unknown> | undefined
      // The app builds this row from its own state; importing the push's version puts a second,
      // unnamed row beside it — and, running on resume, it lands *after* the reconciliation meant to
      // replace it. See `LOCALLY_RECONCILED_KINDS`.
      //
      // ⚠️ **The channel, not just the data.** Android draws a `notification` payload without the app,
      // and notifee's view of an OS-drawn notification carries no data at all — so a DM arrived here
      // with no `kind` and was imported as a row tied to no conversation, which nothing could clear.
      // `channelId` is what survives.
      if (isLocallyReconciled(data) || channelOf(item) === NOTIFEE_DM_CHANNEL_ID) continue
      const dataType = typeof data?.type === 'string' ? data.type : null
      const result = eventFromDisplayed(item)
      if (result.kind === 'dropped') {
        // Origin-tagged per drop reason so Sentry can filter cleanly. The
        // pre-classifier `'notification-sweep'` origin folded id-missing
        // and timestamp-missing into one bucket, obscuring whether iOS
        // FCM/Notifee was the culprit (no id) or the payload itself was
        // malformed (no timestamp).
        logger.warn(`Skipping swept notification reason=${result.reason}`, {
          origin: `notification-sweep/${result.reason}`,
          reason: result.reason,
          notifId: item.notification.id,
          displayedId: item.id,
          dataType,
          hasDate: typeof item.date === 'string' && item.date.length > 0,
          hasNotifId: item.notification.id != null,
        })
        continue
      }

      if (events.some((e) => e.id === result.event.id)) continue

      if (sweepHistory.has(String(result.event.id))) continue
      if (sweptThisCall.has(result.event.id)) continue

      await pushNotificationManager.events.push(result.event).catch((cause) => {
        logger.warn('Failed to store swept notification', {
          origin: 'notification-sweep/store-failed',
          cause,
          notifId: item.notification.id,
          dataType,
        })
      })

      sweptThisCall.add(result.event.id)
    }
  } catch (e) {
    logger.warn('Failed to sweep displayed notifications', {origin: 'notification-sweep', cause: e})
  }
}
