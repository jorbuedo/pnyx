/**
 * Push notification storage layer.
 *
 * Wraps the app's platform `storage` for typed access to:
 * - push events (MMKV, capped at 100)
 * - notification config (per-trigger user preferences)
 * - notification prefs (permission prompted flag, FCM token)
 */

import {logger} from '../logger'
import {storage} from '../platform/storage'
import type {NotificationConfig, PushEvent} from './notification-types'
import {defaultNotificationConfig} from './notification-types'

const EVENTS_KEY = 'push-notifications/events'
const CONFIG_KEY = 'push-notifications/config'
const SWEEP_HISTORY_KEY = 'push-notifications/sweep-history'

const MAX_EVENTS = 100

/**
 * Sweep-history cap (FIFO). Kept generously above MAX_EVENTS so that
 * an id still living in the inbox is never evicted from history — if
 * it were, a sweep could resurrect the row when the underlying iOS
 * banner was still in Notification Center.
 *
 * 5× headroom covers any realistic delete-heavy usage pattern (e.g.
 * user receives 100 events, deletes most, then 400 fresh arrivals
 * before the original entries roll over). iOS auto-clears
 * Notification Center long before the trailing edge of this cap.
 */
const MAX_SWEEP_HISTORY = 500

// ─── Events Storage ───────────────────────────────────────────────────────────

export const eventsStorage = {
  async read(): Promise<PushEvent[]> {
    const raw = await storage.get(EVENTS_KEY)
    if (!raw) return []
    try {
      return JSON.parse(raw) as PushEvent[]
    } catch (e: unknown) {
      // A stored-but-corrupt list and an empty one render the same: no notifications at all.
      logger.warn('Stored push events could not be parsed; reporting none', {
        origin: 'notification-storage',
        error: String(e),
      })
      return []
    }
  },

  async write(events: PushEvent[]): Promise<void> {
    const capped = events.slice(0, MAX_EVENTS)
    await storage.set(EVENTS_KEY, JSON.stringify(capped))
  },

  async clear(): Promise<void> {
    await storage.remove(EVENTS_KEY)
  },
}

// ─── Sweep History ────────────────────────────────────────────────────────────
// Persistent ordered list of every event id `events.push` has ever
// observed. Used by the iOS foreground-sweep path
// (`platform/notification-sweep.ts`) and by `events.push` itself to
// avoid re-importing or resurrecting notifications that:
//   (a) the user explicitly dismissed (delete / clear), or
//   (b) the inbox already stored once but has since aged out of the
//       100-event cap.
// Apple gives us no way to clear an APNs notification from JS, so the
// underlying banner can sit in Notification Center long after we've
// processed it — this history is the single source of truth for
// "we've already handled this".
//
// On-disk format is `string[]` in insertion order (oldest first) so
// the FIFO cap is a single `slice(-MAX_SWEEP_HISTORY)`. `read` returns
// a `Set<string>` so callers get O(1) membership without rebuilding
// the structure on every check.

export type SweepHistory = ReadonlySet<string>

const parseSweepHistoryRaw = (raw: string | null): string[] => {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === 'string')
    return []
  } catch (e: unknown) {
    // Losing the history means an already-swept notification can be swept again.
    logger.warn('Sweep history could not be parsed; treating it as empty', {
      origin: 'notification-storage',
      error: String(e),
    })
    return []
  }
}

export const sweepHistoryStorage = {
  async read(): Promise<SweepHistory> {
    const list = parseSweepHistoryRaw(await storage.get(SWEEP_HISTORY_KEY))
    return new Set(list)
  },

  async add(ids: ReadonlyArray<number | string>): Promise<void> {
    if (ids.length === 0) return
    const current = parseSweepHistoryRaw(await storage.get(SWEEP_HISTORY_KEY))
    const seen = new Set(current)
    let changed = false
    for (const id of ids) {
      const key = String(id)
      if (!seen.has(key)) {
        seen.add(key)
        current.push(key)
        changed = true
      }
    }
    if (!changed) return
    // FIFO cap — keep the most recently inserted ids and drop the
    // tail. The chosen cap leaves enough headroom over the inbox so
    // an in-store event can't have its history entry evicted under
    // realistic usage.
    const capped = current.length > MAX_SWEEP_HISTORY ? current.slice(-MAX_SWEEP_HISTORY) : current
    await storage.set(SWEEP_HISTORY_KEY, JSON.stringify(capped))
  },

  async clear(): Promise<void> {
    await storage.remove(SWEEP_HISTORY_KEY)
  },
}

// ─── Config Storage ───────────────────────────────────────────────────────────

export const configStorage = {
  async read(): Promise<NotificationConfig> {
    const raw = await storage.get(CONFIG_KEY)
    if (!raw) return defaultNotificationConfig
    try {
      const partial = JSON.parse(raw) as Partial<NotificationConfig>
      return {...defaultNotificationConfig, ...partial}
    } catch (e: unknown) {
      // ⚠️ Silently reverts every notification preference the user set to its default.
      logger.warn('Notification config could not be parsed; falling back to defaults', {
        origin: 'notification-storage',
        error: String(e),
      })
      return defaultNotificationConfig
    }
  },

  async save(partial: Partial<NotificationConfig>): Promise<void> {
    const current = await configStorage.read()
    await storage.set(CONFIG_KEY, JSON.stringify({...current, ...partial}))
  },

  async reset(): Promise<void> {
    await storage.remove(CONFIG_KEY)
  },
}

// ─── Notification Prefs ───────────────────────────────────────────────────────

export const notificationPrefs = {
  permissionPrompted: {
    async get(): Promise<boolean> {
      const val = await storage.get('push-notifications/ui/permissionPrompted')
      return val === 'true'
    },

    async set(value: boolean): Promise<void> {
      await storage.set('push-notifications/ui/permissionPrompted', String(value))
    },
  },

  fcmToken: {
    async get(): Promise<string | null> {
      return storage.get('push-notifications/ui/fcmToken')
    },

    async set(token: string): Promise<void> {
      await storage.set('push-notifications/ui/fcmToken', token)
    },

    async remove(): Promise<void> {
      await storage.remove('push-notifications/ui/fcmToken')
    },
  },

  userId: {
    async get(): Promise<string | null> {
      return storage.get('push-notifications/ui/userId')
    },

    async set(id: string): Promise<void> {
      await storage.set('push-notifications/ui/userId', id)
    },

    async remove(): Promise<void> {
      await storage.remove('push-notifications/ui/userId')
    },
  },
}
