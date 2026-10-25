/**
 * Shared push-notification inbox helper.
 *
 * @module
 */

import {logger} from '../logger'
import {pushNotificationManager} from '../services/notification-manager'
import {type PushEvent, Trigger} from '../services/notification-types'

/** Content-dedup window. Mirrors notification-manager's CONTENT_DEDUP_WINDOW_MS. */
export const CONTENT_DEDUP_WINDOW_MS = 60_000

/**
 * Add an incoming push to the inbox, deduping against what's already stored.
 *
 * - Already present by id (any platform): mark it read — no write → `onFail`.
 * - Already present by content (Android, FCM auto-display can store the row
 *   under a different id, so match title + body within
 *   {@link CONTENT_DEDUP_WINDOW_MS}): mark it read (a tap acts on the row), then
 *   if the stored row is uncategorized (`Trigger.Push`) and this push resolved a
 *   real category, enrich it in place (`update`, preserving id/position) →
 *   `onSuccess`; otherwise no further write → `onFail`.
 * - Not present: store it, then mark read → `onSuccess`.
 *
 * `onSuccess` fires whenever a push or update write happens; `onFail` fires when
 * the row already existed and nothing new was written. Callers use these for
 * navigation. Shared by `firebase.onNotificationOpenedApp` and
 * `notifee-setup.handleNotificationPress`.
 */
/** Mark a row read, surviving a storage failure — the badge count is wrong either way, so say which. */
const markRead = (id: number, branch: 'byId' | 'byContent' | 'stored'): Promise<void> =>
  pushNotificationManager.events.markAsRead(id).catch((e) => {
    logger.warn('Failed to mark a notification read; the unread badge will over-count', {
      origin: 'addNotif',
      id,
      branch,
      error: String(e),
    })
  })

export async function addNotif(args: {
  readonly event: PushEvent
  readonly existingEvents: readonly PushEvent[]
  readonly isAndroid: boolean
  readonly onSuccess?: () => void | Promise<void>
  readonly onFail?: () => void | Promise<void>
}): Promise<void> {
  const {event, existingEvents, isAndroid} = args

  const byId = existingEvents.find((e) => e.id === event.id)
  if (byId) {
    await markRead(byId.id, 'byId')
    await args.onFail?.()
    return
  }

  if (isAndroid) {
    const dateMs = new Date(event.date).getTime()
    const byContent = existingEvents.find(
      (e) =>
        e.title === event.title &&
        e.body === event.body &&
        Math.abs(dateMs - new Date(e.date).getTime()) < CONTENT_DEDUP_WINDOW_MS,
    )
    if (byContent) {
      // A tap acts on the row regardless of whether we enrich it — mark read
      // here so the badge clears, mirroring the by-id and not-present branches.
      // Without this, a content-matched row stays unread and the count drifts.
      await markRead(byContent.id, 'byContent')
      if (byContent.trigger === Trigger.Push && event.trigger !== Trigger.Push) {
        await pushNotificationManager.events
          .update(byContent.id, {data: event.data, trigger: event.trigger})
          .catch((e) => {
            logger.warn('Failed to enrich a stored notification; it keeps its uncategorized trigger', {
              origin: 'addNotif',
              id: byContent.id,
              error: String(e),
            })
          })
        await args.onSuccess?.()
      } else {
        await args.onFail?.()
      }
      return
    }
  }

  // Not in the inbox — store it, then mark read. The id push() returns may have
  // collapsed onto an existing row via the manager's own content-dedup; a null
  // return (skipped) still attempts markAsRead on `event.id` in case the row is
  // present in storage.
  const storedId = await pushNotificationManager.events.push(event).catch((e) => {
    logger.warn('Failed to store an incoming notification; it stays out of the inbox', {
      origin: 'addNotif',
      id: event.id,
      error: String(e),
    })
    return null
  })
  await markRead(storedId ?? event.id, 'stored')
  await args.onSuccess?.()
}
