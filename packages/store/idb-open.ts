import {Effect, Schedule} from 'effect'
import type {StoreError} from './errors.js'

/**
 * Chrome's MV3 service worker transiently fails `indexedDB.open` with
 * `UnknownError: Internal error opening backing store` when the worker wakes
 * before its storage partition is ready, after an unclean termination, or while
 * another connection is mid-open. The condition clears on a retry, so back off
 * and re-attempt before surfacing the `StoreError`. (seen in production Sentry)
 *
 * 6 retries on a 50ms-base exponential → ≈50/100/200/400/800/1600ms, ~3.15s
 * total over 7 attempts. There's no authoritative figure for how long the
 * backing-store transient takes to clear, so the tail deliberately stretches
 * into the second-plus range to give browser-level eventual consistency time
 * to settle. This costs nothing on the common path (the first `open()`
 * succeeds with zero delay); the retry tail only runs when the store is
 * genuinely unavailable, where waiting a few seconds beats degrading to a
 * non-persistent memory store for the session.
 */
export const withIndexedDbOpenRetry = <A>(open: Effect.Effect<A, StoreError>): Effect.Effect<A, StoreError> =>
  open.pipe(Effect.retry(Schedule.exponential('50 millis').pipe(Schedule.intersect(Schedule.recurs(6)))))
