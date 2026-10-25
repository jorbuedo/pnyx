/**
 * Reconnect timing for the realtime socket.
 *
 * Pure so the schedule is testable without a socket or a clock — the part that goes wrong is the
 * *policy*, not the plumbing: a client that retries hard against a service having a bad minute turns an
 * outage into a stampede, and one that retries too politely leaves a user looking at a stale screen.
 *
 * @module
 */

/** Ceiling, so a long outage settles into a slow retry rather than stopping. */
const MAX_DELAY_MS = 30_000
const BASE_DELAY_MS = 1_000

/**
 * Delay before attempt `n` (1-based), with jitter.
 *
 * Exponential to back off a service under load, capped so a client that has been disconnected for an
 * hour still reconnects within half a minute of the service returning. **Jittered** because every
 * client of a service that just restarted would otherwise retry in lockstep and re-flatten it —
 * ±25% is enough to spread a herd without making the first retry feel slow.
 */
export const reconnectDelayMs = (attempt: number, random: () => number = Math.random): number => {
  const exponential = Math.min(BASE_DELAY_MS * 2 ** Math.max(attempt - 1, 0), MAX_DELAY_MS)
  const jitter = 1 + (random() - 0.5) / 2
  return Math.round(exponential * jitter)
}

/**
 * Whether a close code is worth retrying.
 *
 * A ticket that expired or a subject that lost access closes with a policy code, and retrying that in a
 * loop is how a client burns battery achieving nothing — the fix is a new ticket, which happens on the
 * next explicit connect. Everything else (network drops, hibernation, a deploy) is transient.
 */
export const shouldReconnect = (code: number): boolean => code !== 1008 && code !== 4401
