/**
 * Pending push-notification intent store.
 *
 * Buffers a tapped push when the app can't honour it immediately
 * (cold-start lock window, SIWE not yet `'ready'`). Downstream
 * consumers peek/consume once prerequisites settle and route through
 * their normal rails — this module never calls `router.navigate`.
 *
 * MMKV-backed: the in-memory `current` is mirrored to disk
 * so an intent survives a JS bridge restart that can happen between
 * notification tap, biometric unlock, and the wallet provider tree
 * mounting. The 5-min TTL still bounds replay, so a stale intent on
 * a later launch is still bounded to a few minutes of risk.
 *
 * @module
 */

import {logger} from '../logger'

// Card packages are gone — the buffered-intent shapes keep plain-string ids
// so persisted intents from older installs still parse.
type CardIdentity = string
type CardId = string

import {storage} from '../platform/storage'

// 5min: long enough to survive a biometric retry, short enough to die before a tap-and-forget surprise.
const INTENT_TTL_MS = 5 * 60_000

// MMKV / chrome.storage key. Single-slot — the in-memory contract is
// also single-slot (one buffered intent at a time), so persisting under
// one key keeps disk + memory in lockstep.
const STORAGE_KEY = '@pnyx/push-intent/current'

export type PendingPushIntent =
  /**
   * `userAddress` and `cardId` are echoed from the server push payload so
   * multi-card users land on the right group/card. They're optional: older
   * buffered intents predate the fields, and payloads where the server omits
   * them still navigate based on `txId` alone (single-card cohort).
   */
  | {
      readonly kind: 'card-3ds'
      readonly txId: string
      readonly createdAtMs: number
      readonly userAddress?: CardIdentity
      readonly cardId?: CardId
    }
  | {readonly kind: 'card-activity'; readonly activityId: string; readonly createdAtMs: number}
  | {readonly kind: 'card'; readonly createdAtMs: number}
  | {readonly kind: 'settings'; readonly createdAtMs: number}

type Listener = (next: PendingPushIntent | null) => void

let current: PendingPushIntent | null = null
let hydratedFromStorage = false
const listeners: Set<Listener> = new Set()

// Validate a JSON-parsed value before trusting it as an intent. Disk
// content is attacker-controlled in the same sense any local-storage
// blob is: a corrupted or forward-compat-broken payload must not crash
// callers downstream.
const isValidIntent = (value: unknown): value is PendingPushIntent => {
  if (!value || typeof value !== 'object') return false
  const obj = value as Record<string, unknown>
  if (typeof obj.createdAtMs !== 'number') return false
  switch (obj.kind) {
    case 'card-3ds': {
      if (typeof obj.txId !== 'string' || obj.txId.length === 0) return false
      // Optional fields: reject only if present-but-malformed, so an older
      // buffered intent (no userAddress / cardId) still validates and a
      // forward-compat payload carrying garbage values doesn't slip through.
      if (obj.userAddress !== undefined) {
        if (typeof obj.userAddress !== 'string' || obj.userAddress.length === 0) return false
      }
      if (obj.cardId !== undefined && (typeof obj.cardId !== 'string' || obj.cardId.length === 0)) return false
      return true
    }
    case 'card-activity':
      return typeof obj.activityId === 'string' && obj.activityId.length > 0
    case 'card':
    case 'settings':
      return true
    default:
      return false
  }
}

const persistToStorage = (next: PendingPushIntent | null): void => {
  try {
    if (next === null) {
      void storage.remove(STORAGE_KEY)
    } else {
      void storage.set(STORAGE_KEY, JSON.stringify(next))
    }
  } catch (err) {
    logger.warn(`[push-intent] persist failed: ${String(err)}`, {origin: 'push-intent'})
  }
}

// Synchronous cold-start hydration. Runs once per process on first
// `peek/consume/set/clear`. On RN this is MMKV (sync); on web/extension
// `getSync` returns null and the buffered intent is memory-only — same
// behaviour as before.
//
// The `hydratedFromStorage` flag is set only after a successful read +
// parse completes. A throw at any step leaves the flag false so the
// next `peek`/`set` retries — a transient storage failure (mid-write,
// brief MMKV unavailability) must not permanently disable hydration.
const ensureHydrated = (): void => {
  if (hydratedFromStorage) return
  try {
    const raw = storage.getSync(STORAGE_KEY)
    if (!raw) {
      hydratedFromStorage = true
      return
    }
    const parsed: unknown = JSON.parse(raw)
    if (!isValidIntent(parsed)) {
      void storage.remove(STORAGE_KEY)
      hydratedFromStorage = true
      return
    }
    if (Date.now() - parsed.createdAtMs >= INTENT_TTL_MS) {
      void storage.remove(STORAGE_KEY)
      hydratedFromStorage = true
      return
    }
    if (current === null) {
      current = parsed
      logger.info(`[push-intent] hydrated kind=${parsed.kind} ageMs=${Date.now() - parsed.createdAtMs}`, {
        origin: 'push-intent',
      })
    }
    hydratedFromStorage = true
  } catch (err) {
    // Leave `hydratedFromStorage = false` so the next call retries.
    logger.warn(`[push-intent] hydrate failed: ${String(err)}`, {origin: 'push-intent'})
  }
}
// Tracks txIds for which the suppression-override has already fired,
// so a cancel → 30s poll → re-prompt loop is bounded to one attempt
// per buffered intent. Cleared when the intent identity changes or is
// consumed/cleared/TTL-dropped.
let overrideAttemptedTxIds: Set<string> = new Set()

// Track txIds that were just orphaned by a state-loss overwrite, mapped to
// the absolute deadline (ms) past which the entry is stale. The 3DS poll
// consumes entries via `consumeOverwrittenTxIdIfPresent` to emit a recovery
// signal when an orphaned tx eventually surfaces via the BaaS feed.
const OVERWRITE_RECOVERY_WINDOW_MS = 5 * 60_000
const recentlyOverwrittenTxIds: Map<string, number> = new Map()

// Drop any entries whose deadline has passed. Called on every overwrite
// write so the Map can't grow unbounded if BaaS never surfaces the
// orphaned txId (e.g. the partner-side TTL fired first).
const sweepStaleOverwrites = (nowMs: number): void => {
  for (const [txId, expiresAt] of recentlyOverwrittenTxIds) {
    if (nowMs > expiresAt) recentlyOverwrittenTxIds.delete(txId)
  }
}

const notify = (next: PendingPushIntent | null): void => {
  for (const fn of listeners) {
    try {
      fn(next)
    } catch (err) {
      // Subscriber bug — escalate so Sentry captures the stack
      // (warn-level meta loses it; error-level + Error as first arg
      // hits the captureException branch of the sentry transport).
      logger.error(err instanceof Error ? err : new Error(String(err)), {
        origin: 'push-intent',
        intentKind: next?.kind ?? 'null',
      })
    }
  }
}

const isExpired = (intent: PendingPushIntent, nowMs: number): boolean => nowMs - intent.createdAtMs >= INTENT_TTL_MS

const identityOf = (intent: PendingPushIntent): string | null => {
  switch (intent.kind) {
    case 'card-3ds':
      return intent.txId
    case 'card-activity':
      return intent.activityId
    case 'card':
    case 'settings':
      return null
  }
}

// State-loss = same kind, both carry an identity, identities differ.
// Kindless overwrites (e.g. two 'card' taps) collapse onto a single
// route and aren't a loss; same kind + matching id is idempotent.
const isStateLossOverwrite = (prev: PendingPushIntent, next: PendingPushIntent): boolean => {
  if (prev.kind !== next.kind) return false
  const prevId = identityOf(prev)
  const nextId = identityOf(next)
  if (prevId === null || nextId === null) return false
  return prevId !== nextId
}

const dropIfExpired = (nowMs: number): PendingPushIntent | null => {
  if (!current) return null
  if (!isExpired(current, nowMs)) return current
  // TTL drop is the principal cold-start failure mode this module
  // mitigates. Warn so it surfaces in Sentry — info would be
  // breadcrumb-only and the rate of drops would be unobservable.
  logger.warn(`[push-intent] dropped (TTL elapsed) kind=${current.kind} ageMs=${nowMs - current.createdAtMs}`, {
    origin: 'push-intent',
  })
  current = null
  overrideAttemptedTxIds = new Set()
  persistToStorage(null)
  notify(null)
  return null
}

export const pendingPushIntent = {
  set(intent: PendingPushIntent): void {
    ensureHydrated()
    if (current) {
      // Same kind + same identity = idempotent re-set (e.g. user re-
      // taps the same notification). Different identity = state
      // loss: a second push tap is overwriting an earlier one, and
      // the earlier target will never be navigated to.
      if (isStateLossOverwrite(current, intent)) {
        logger.warn(`[push-intent] overwriting in-flight intent — first tap will be lost`, {
          origin: 'push-intent',
          prevKind: current.kind,
          nextKind: intent.kind,
          prevId: identityOf(current),
          nextId: identityOf(intent),
        })
        // Track the orphaned txId so the next BaaS poll that surfaces it
        // can log a recovery signal — denominator for the overwrite-loss
        // measurement in `docs/PUSH_INTENT_OVERWRITE_LOSS.md`.
        if (current.kind === 'card-3ds') {
          const now = Date.now()
          sweepStaleOverwrites(now)
          recentlyOverwrittenTxIds.set(current.txId, now + OVERWRITE_RECOVERY_WINDOW_MS)
        }
      } else {
        logger.info(`[push-intent] replacing previous kind=${current.kind} with kind=${intent.kind}`, {
          origin: 'push-intent',
        })
      }
    }
    logger.info(`[push-intent] captured kind=${intent.kind}`, {origin: 'push-intent'})
    if (current && identityOf(current) !== identityOf(intent)) overrideAttemptedTxIds = new Set()
    current = intent
    persistToStorage(intent)
    notify(intent)
  },
  peek(): PendingPushIntent | null {
    ensureHydrated()
    return dropIfExpired(Date.now())
  },
  consume(): PendingPushIntent | null {
    ensureHydrated()
    const alive = dropIfExpired(Date.now())
    if (!alive) return null
    logger.info(`[push-intent] consumed kind=${alive.kind} ageMs=${Date.now() - alive.createdAtMs}`, {
      origin: 'push-intent',
    })
    current = null
    overrideAttemptedTxIds = new Set()
    persistToStorage(null)
    notify(null)
    return alive
  },
  clear(): void {
    ensureHydrated()
    if (!current) return
    logger.debug(`[push-intent] cleared kind=${current.kind}`, {origin: 'push-intent'})
    current = null
    overrideAttemptedTxIds = new Set()
    persistToStorage(null)
    notify(null)
  },
  subscribe(fn: Listener): () => void {
    listeners.add(fn)
    return () => {
      listeners.delete(fn)
    }
  },
  markOverrideAttempted(txId: string): void {
    overrideAttemptedTxIds.add(txId)
  },
  hasOverrideBeenAttempted(txId: string): boolean {
    return overrideAttemptedTxIds.has(txId)
  },
}

/**
 * Check whether `txId` was orphaned by a recent state-loss overwrite. Returns
 * the original overwrite timestamp (ms) and clears the entry, or `null` if
 * the txId was not recently overwritten or its 5-min window has elapsed.
 *
 * Callers (the 3DS poll merge step) use this to log a recovery signal when a
 * previously-orphaned txId surfaces in a fresh BaaS response — denominator
 * for the overwrite-loss measurement.
 */
export const consumeOverwrittenTxIdIfPresent = (txId: string): number | null => {
  const expiresAt = recentlyOverwrittenTxIds.get(txId)
  if (expiresAt == null) return null
  recentlyOverwrittenTxIds.delete(txId)
  if (Date.now() > expiresAt) return null
  return expiresAt - OVERWRITE_RECOVERY_WINDOW_MS
}

/** Test-only — reset all module state. Do not call from production code. */
export const __resetPendingPushIntentForTests = (): void => {
  current = null
  hydratedFromStorage = false
  listeners.clear()
  overrideAttemptedTxIds = new Set()
  recentlyOverwrittenTxIds.clear()
}
