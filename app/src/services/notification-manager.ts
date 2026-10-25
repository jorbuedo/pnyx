/**
 * Push notification event manager.
 */

import {Platform} from 'react-native'
import {logger} from '../logger'
import {setAppBadgeCount} from '../platform/notification-badge'
import {configStorage, eventsStorage, sweepHistoryStorage} from './notification-storage'
import {type Group, type NotificationConfig, type PushEvent, Trigger, triggerGroups} from './notification-types'

/**
 * Record an event id in the sweep history.
 *
 * The sweep history is the only mechanism that prevents the foreground
 * sweep (`platform/notification-sweep.ts`) from resurrecting a row the
 * user has already removed from the inbox while it still sits in the OS
 * notification shade. The sweep now runs on iOS AND Android (Android
 * needs the same backstop after force-stop / OEM background-killer
 * scenarios where `setBackgroundMessageHandler` didn't fire), so the
 * history must be recorded — and consulted — on both platforms.
 *
 * Previously gated to iOS because Android relied solely on the headless
 * handler to populate the inbox and the sweep was a no-op there; lifting
 * the gate keeps the write path consistent with the read path in
 * `events.push`.
 */
const recordSweepHistory = async (ids: ReadonlyArray<number | string>): Promise<void> => {
  await sweepHistoryStorage.add(ids)
}

type Listener<T> = (value: T) => void

export class SimpleSubject<T> {
  private readonly listeners: Set<Listener<T>> = new Set()

  subscribe(listener: Listener<T>): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  next(value: T): void {
    this.listeners.forEach((l) => l(value))
  }
}

function buildUnreadCounterDefault(): Map<Group, number> {
  return new Map<Group, number>((Object.values(triggerGroups) as Group[]).map((group) => [group, 0]))
}

function shouldNotify(event: PushEvent, config: NotificationConfig): boolean {
  const triggerConfig = config[event.trigger as keyof NotificationConfig]
  return triggerConfig?.notify ?? false
}

function getGroup(trigger: Trigger): Group {
  return triggerGroups[trigger]
}

/**
 * Semantic bucket for card-partner user-status pushes. Mirrors the backend grouping
 * in `services/.../send-notification.ts` so the FE collapses synonymous
 * transitions the same way (Pending+InReview → "in-progress",
 * Canceled+Rejected → "update"). Returns `null` for non-user payloads.
 *
 * Buckets are namespaced (`kyc:` vs `acct:`) so a `verification_status` and
 * an `account status` value that happen to share a string don't collide.
 */
export function userStatusBucket(data: Record<string, unknown>): string | null {
  if (data.type !== 'user') return null
  const verification = typeof data.verificationStatus === 'string' ? data.verificationStatus : ''
  if (verification) {
    if (verification === 'Pending' || verification === 'InReview') return 'kyc:in-progress'
    if (verification === 'Canceled' || verification === 'Rejected') return 'kyc:update'
    return `kyc:${verification.toLowerCase()}`
  }
  const account = typeof data.status === 'string' ? data.status : ''
  if (account) return `acct:${account.toLowerCase()}`
  return null
}

function createPushNotificationManager() {
  const newEvents$ = new SimpleSubject<PushEvent>()
  const unreadCounterByGroup$ = new SimpleSubject<Map<Group, number>>()

  const totalUnreadFromCounter = (counter: Map<Group, number>): number =>
    Array.from(counter.values()).reduce((sum, n) => sum + n, 0)

  // Serialize OS-badge writes so concurrent `updateUnreadCounter` calls
  // (e.g. launch `hydrate()` overlapping with the iOS foreground sweep
  // importing displayed notifications) can't reorder their
  // `setAppBadgeCount` calls and end with an earlier total overwriting a
  // later one on the app icon. Chain runs writes in scheduling order;
  // the most recently scheduled value (which reflects the most recent
  // storage read) is what the OS settles on.
  let badgeChain: Promise<unknown> = Promise.resolve()
  const scheduleBadgeWrite = (total: number): Promise<unknown> => {
    badgeChain = badgeChain.then(
      () => setAppBadgeCount(total),
      () => setAppBadgeCount(total),
    )
    return badgeChain
  }

  const updateUnreadCounter = async (): Promise<void> => {
    const allEvents = await eventsStorage.read()
    const counter = buildUnreadCounterDefault()
    allEvents
      .filter((e) => !e.isRead)
      .forEach((e) => {
        const group = getGroup(e.trigger)
        counter.set(group, (counter.get(group) ?? 0) + 1)
      })
    unreadCounterByGroup$.next(counter)
    await scheduleBadgeWrite(totalUnreadFromCounter(counter))
  }

  // Serialize all read-modify-write inbox operations so concurrent
  // callers (foreground onMessage + iOS sweep + tap handler all running
  // in overlapping promise continuations) can't interleave their
  // `eventsStorage.read` → compute → `eventsStorage.write` cycles and
  // either lose writes, defeat dedup, or resurrect just-cleared rows.
  let writeChain: Promise<unknown> = Promise.resolve()
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = writeChain.then(fn, fn)
    writeChain = next.catch((e) => {
      // Keeps the chain from staying rejected. `next` carries the rejection to the caller,
      // so this is a debug note, not the report.
      logger.debug('Serialized notification write rejected', {origin: 'NotificationManager', error: String(e)})
    })
    return next
  }

  const config = {
    read(): Promise<NotificationConfig> {
      return configStorage.read()
    },
    async save(partial: Partial<NotificationConfig>): Promise<void> {
      await configStorage.save(partial)
    },
    async reset(): Promise<void> {
      await configStorage.reset()
    },
  }

  /** Window in which identical-content notifications are considered duplicates (ms). */
  const CONTENT_DEDUP_WINDOW_MS = 60_000

  /**
   * Window for collapsing duplicate KYC / account-status pushes. The card partner
   * re-emits the same transition over a long retry tail (observed ~10 min
   * between retries; backend idempotency catches identical payloads but
   * timestamp drift on the wire defeats it). 24h spans a realistic KYC
   * review cycle while still letting a genuinely re-issued status
   * (e.g. user re-submits next day) surface a fresh notification.
   */
  const USER_STATUS_DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000

  const events = {
    /**
     * Store an incoming push event.
     *
     * Returns the id of the event that is now in storage:
     * - the incoming `event.id` when stored normally
     * - the existing duplicate's id when content-deduplication fires
     * - `null` when the event is blocked by the user's notification config
     * - `null` when the id is already in the sweep history — meaning the
     *   event has previously been processed and either still lives in the
     *   inbox, aged out of the cap, or was explicitly deleted by the user.
     *   This is what prevents a tap on a lingering Notification-Center
     *   banner from resurrecting a row the user already cleared.
     *
     * Callers that follow up with `markAsRead` must use the returned id
     * rather than `event.id`, because content-dedup may have dropped the
     * incoming event in favour of a previously stored one with a different id.
     * When `push` returns `null` because the id was in history, callers
     * should still attempt `markAsRead(event.id)` — the row may exist (the
     * user just tapped a notification that's already in the inbox) and the
     * call is a no-op if it's been deleted.
     */
    push(event: PushEvent): Promise<number | null> {
      return serialize(async () => {
        const cfg = await config.read()
        if (!shouldNotify(event, cfg)) return null

        // A contentless push (no title and no body) has nothing to render in
        // the inbox — the row falls back to the bare "Notifications" title with
        // an empty body. Data-only messages (sync/status pings, FCM group
        // summaries) arrive this way; drop them at the single inbox choke point
        // so no entry path (foreground onMessage, background handler, the
        // foreground sweep, taps) can create a phantom row.
        if (!event.title && !event.body) return null

        // Sweep history is populated on every successful push (see
        // `recordSweepHistory`). If the id is already in it the event has
        // been processed before — either it's still in the inbox (no
        // duplicate), aged out of the cap (don't resurrect old noise),
        // or the user explicitly deleted it (don't override their choice).
        // Active on both iOS and Android now that the foreground sweep
        // runs on Android too — without this check, the Android sweep
        // would re-import any system-shade-resident notification the user
        // had already removed from the inbox.
        const history = await sweepHistoryStorage.read()
        if (history.has(String(event.id))) return null

        const current = await eventsStorage.read()
        const eventTime = new Date(event.date).getTime()

        // KYC / account-status dedup: collapse card-partner user-status pushes that
        // share a semantic bucket (Pending+InReview both render as
        // "Verification In Progress") within a 24h window. A backend fix
        // tightens idempotency at source, but stale pushes already on a
        // device, and any future payload variation that slips past the
        // backend hash, still need a client-side guard.
        const incomingUserBucket = userStatusBucket(event.data)
        if (incomingUserBucket) {
          const existingUser = current.find((e) => {
            if (e.id === event.id) return false
            const bucket = userStatusBucket(e.data)
            if (bucket !== incomingUserBucket) return false
            return Math.abs(eventTime - new Date(e.date).getTime()) < USER_STATUS_DEDUP_WINDOW_MS
          })
          if (existingUser) {
            // Refresh the kept row with the latest payload so a synonymous
            // transition (Pending → InReview, Canceled → Rejected) reflects
            // the most recent title/body/data if BE ever differentiates them.
            // Preserve id + isRead — the new push is a duplicate continuation,
            // not a new event, so a row the user already cleared stays cleared.
            const refreshedRow = {
              ...existingUser,
              title: event.title,
              body: event.body,
              data: event.data,
              date: event.date,
            }
            const refreshed = current.map((e) => (e.id === existingUser.id ? refreshedRow : e))
            await eventsStorage.write(refreshed)
            await recordSweepHistory([event.id])
            // Resync counter + OS badge: the inbox total didn't change, but
            // APNs / the Android system may have bumped the icon badge for
            // the incoming push before dedup ran. Recomputing from storage
            // pushes the correct total back to notifee so badge drift can't
            // accumulate over a retry storm.
            await updateUnreadCounter()
            // Emit on the stream so live subscribers (notifications list,
            // card data refresh) repaint with the refreshed payload —
            // without this, subscribers only pick up the new title / body
            // on next focus or read().
            newEvents$.next(refreshedRow)
            return existingUser.id
          }
        }

        // Content-level deduplication: KYC providers (and other backends) can fire the
        // same webhook multiple times, producing FCM messages with different IDs
        // but identical title/body. When that happens, return the existing
        // event's id so tap-handler callers can still mark the right event as read.
        //
        // On Android the trigger is deliberately NOT part of the match key. The
        // same push lands through two paths with the SAME title/body but a DIFFERENT
        // trigger: the data-rich background handler / foreground onMessage classify
        // it (e.g. `card-transaction`), while the foreground sweep reads the
        // system-auto-displayed notification whose data payload is empty, so
        // `deriveSweptTrigger` can only fall back to `push`. Keying dedup on the
        // derived trigger let that pair through as two rows; matching on
        // title+body+window collapses them. This empty-payload split is Android-only
        // (iOS sweep keeps the data + remote messageId), so iOS retains the original
        // trigger-sensitive match to avoid collapsing distinct same-text pushes.
        const isAndroid = Platform.OS === 'android'
        const existing = current.find(
          (e) =>
            e.id !== event.id &&
            e.title === event.title &&
            e.body === event.body &&
            (isAndroid || e.trigger === event.trigger) &&
            Math.abs(eventTime - new Date(e.date).getTime()) < CONTENT_DEDUP_WINDOW_MS,
        )
        if (existing) {
          // Upgrade a degraded sweep row in place (Android only — see above). The
          // foreground sweep can store the row first (empty auto-display payload →
          // `Trigger.Push`, no `data`) before the data-rich handler delivers the same
          // notification with a real trigger + payload. Without this, dedup keeps the
          // first (degraded) row and the inbox never categorizes it — mirrors the
          // addNotif and KYC branches. Preserve id/position/read-state; only enrich
          // classification + data.
          if (isAndroid && existing.trigger === Trigger.Push && event.trigger !== Trigger.Push) {
            const upgraded = {...existing, trigger: event.trigger, data: event.data}
            await eventsStorage.write(current.map((e) => (e.id === existing.id ? upgraded : e)))
            if (!upgraded.isRead) newEvents$.next(upgraded)
          }
          await recordSweepHistory([event.id])
          // Same OS-badge resync rationale as the KYC dedup branch above.
          await updateUnreadCounter()
          return existing.id
        }

        // Deduplicate by id (same messageId from background + tap handlers) then prepend, cap at 100
        const deduped = current.filter(({id}) => id !== event.id)
        await eventsStorage.write([event, ...deduped])

        // Record the id in the sweep history so a later iOS foreground
        // sweep doesn't re-import the same notification — covers both
        // "user later deletes it" and "event has since aged out of the
        // 100-cap" cases. Done after the successful write so a failed
        // storage write doesn't leak a phantom id into the ledger.
        await recordSweepHistory([event.id])

        // Always recompute on a successful push so the OS badge is
        // reconciled with the inbox even when the event lands as already
        // read (e.g. a notification-tap handler that pushes + immediately
        // marks read — the OS still bumped the badge for the original
        // arrival).
        await updateUnreadCounter()
        if (!event.isRead) {
          newEvents$.next(event)
        }
        return event.id
      })
    },

    async read(): Promise<PushEvent[]> {
      return eventsStorage.read()
    },

    markAsRead(id: number): Promise<void> {
      return serialize(async () => {
        const current = await eventsStorage.read()
        const updated = current.map((e) => (e.id === id ? {...e, isRead: true} : e))
        await eventsStorage.write(updated)
        await updateUnreadCounter()
      })
    },

    /**
     * Patch an existing event in place by id, preserving its id, position, and
     * (unless overridden) read-state. Used to enrich a row already in the inbox
     * — e.g. a preview-era push that landed uncategorized, then a richer
     * duplicate resolves its `trigger`/`data` — without the remove+re-add churn
     * that would reset its position and read-state. No-op if `id` is absent.
     */
    update(id: number, patch: Partial<Omit<PushEvent, 'id'>>): Promise<void> {
      return serialize(async () => {
        const current = await eventsStorage.read()
        if (!current.some((e) => e.id === id)) return
        const updated = current.map((e) => (e.id === id ? {...e, ...patch} : e))
        await eventsStorage.write(updated)
        await updateUnreadCounter()
      })
    },

    markAllAsRead(): Promise<void> {
      return serialize(async () => {
        const current = await eventsStorage.read()
        const updated = current.map((e) => ({...e, isRead: true}))
        await eventsStorage.write(updated)
        unreadCounterByGroup$.next(buildUnreadCounterDefault())
        await scheduleBadgeWrite(0)
      })
    },

    remove(id: number): Promise<void> {
      return serialize(async () => {
        const current = await eventsStorage.read()
        const filtered = current.filter((e) => e.id !== id)
        await eventsStorage.write(filtered)
        // No history write needed — `push` already recorded the id when
        // the event landed, so the iOS sweep already knows not to
        // resurrect this notification from Notification Center.
        await updateUnreadCounter()
      })
    },

    clear(): Promise<void> {
      return serialize(async () => {
        // No history write needed — every cleared id was already
        // recorded at push time, so the iOS sweep won't re-import them.
        await eventsStorage.clear()
        unreadCounterByGroup$.next(buildUnreadCounterDefault())
        await scheduleBadgeWrite(0)
      })
    },
  }

  const hydrate = (): void => {
    serialize(async () => {
      // One-shot purge of contentless rows that pre-#2248 builds wrote to
      // storage before the central `events.push` guard existed. Without
      // this, an update from a buggy version leaves `!title && !body`
      // rows in the inbox — they render under the fallback "Notifications"
      // label and inflate the unread counter / OS badge. The filter is a
      // no-op once storage is clean, so running it on every hydrate is
      // self-stabilising.
      const current = await eventsStorage.read()
      const purged = current.filter((e) => e.title || e.body)
      if (purged.length !== current.length) {
        await eventsStorage.write(purged)
      }
      await updateUnreadCounter()
    }).catch((e) => {
      logger.error('Failed to hydrate push notification counter', {
        origin: 'push-notifications/notification-manager',
        cause: e,
      })
      // Defensive fallback: a hydrate failure is the only thing standing
      // between a stale OS badge (from APNs/FCM) and a clean inbox-driven
      // value. If the read fails, clear the badge instead of leaving an
      // arbitrary count visible.
      void scheduleBadgeWrite(0)
    })
  }

  const destroy = (): void => {
    // No active subscriptions to clean up in this SimpleSubject implementation.
  }

  const clear = async (): Promise<void> => {
    await config.reset()
    await events.clear()
    await sweepHistoryStorage.clear()
  }

  return {
    /** Stream of new (unread) events as they arrive. Subscribe to update UI. */
    newEvents$,
    /** Stream of unread counts per group. Subscribe to update badge counts. */
    unreadCounterByGroup$,
    events,
    config,
    hydrate,
    destroy,
    clear,
  }
}

export const pushNotificationManager = createPushNotificationManager()
