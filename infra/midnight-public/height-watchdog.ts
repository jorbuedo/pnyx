/**
 * Does the indexer's height still move? Run it every 5 minutes.
 *
 * This exists because three separate multi-hour outages were found by a human asking an unrelated
 * question, and in all three every external signal read healthy:
 *
 *   - `/ready` answers 200 forever once `caught_up` latches, so at the tip it says nothing about
 *     progress. On 2026-10-15 it read 200 through a 17-hour stall.
 *   - `podman ps` read `Up` through all three.
 *   - `restart: unless-stopped` cannot help the wedge class at all: the process does not exit, it
 *     spins. On 2026-10-15 it logged `subscription appears stuck, re-subscribing` 2,063 times.
 *   - The read-ahead proxy's `cursor` freezes at the tip *by design*, so it cannot tell "finished"
 *     from "stopped" either.
 *
 * So the only honest instrument is `max(height)` compared against itself, and the only useful
 * response is the restart that `unless-stopped` will never issue. A watchdog that merely logged
 * would be the same failure mode a fourth time.
 *
 * It restarts only a container that is *running* but not progressing. A container someone stopped
 * is someone's deliberate state and is left alone; a crash-looping one is already covered by its
 * restart policy.
 */

export const STUCK_CHECKS_BEFORE_RESTART = 2
export const RESTART_COOLDOWN_MS = 30 * 60_000
export const MAX_RESTARTS = 3

export type WatchdogState = {
  /** Last height actually observed, or null before the first readable sample. */
  height: number | null
  /** ISO timestamp of when the height was first seen at this value. */
  heightSince: string | null
  /** Consecutive readable checks at the same height. */
  stuckChecks: number
  /** Restarts issued since the height last moved. */
  restarts: number
  lastRestartAt: string | null
}

export const INITIAL_STATE: WatchdogState = {
  height: null,
  heightSince: null,
  stuckChecks: 0,
  restarts: 0,
  lastRestartAt: null,
}

export type Sample =
  | {readable: true; height: number; containerRunning: boolean}
  /** The height query failed. Never counted as stuck: a transient read error is not a stall. */
  | {readable: false; error: string}

export type WatchdogAction =
  | {action: 'advancing'; from: number | null; to: number; gained: number}
  | {action: 'first-sample'; height: number}
  | {action: 'unreadable'; error: string}
  | {action: 'hold'; height: number; stuckChecks: number; reason: 'below-threshold' | 'cooling-down' | 'not-running'}
  | {action: 'restart'; height: number; stuckChecks: number; attempt: number}
  | {action: 'escalate'; height: number; stuckChecks: number; restarts: number; stuckSince: string | null}

export type Decision = {act: WatchdogAction; next: WatchdogState}

export const decide = (prev: WatchdogState, sample: Sample, nowMs: number): Decision => {
  const now = new Date(nowMs).toISOString()

  if (!sample.readable) {
    // Leave the state untouched: the next readable sample compares against the same height as
    // before, so a flaky read neither resets nor advances the stall count.
    return {act: {action: 'unreadable', error: sample.error}, next: prev}
  }

  if (prev.height === null) {
    return {
      act: {action: 'first-sample', height: sample.height},
      next: {height: sample.height, heightSince: now, stuckChecks: 0, restarts: 0, lastRestartAt: null},
    }
  }

  if (sample.height !== prev.height) {
    // Any movement clears everything, including the restart budget. A height that moves backwards
    // is still movement -- it means something reset -- and is reported as a negative gain rather
    // than silently treated as progress.
    return {
      act: {action: 'advancing', from: prev.height, to: sample.height, gained: sample.height - prev.height},
      next: {height: sample.height, heightSince: now, stuckChecks: 0, restarts: 0, lastRestartAt: null},
    }
  }

  const stuckChecks = prev.stuckChecks + 1
  const next: WatchdogState = {...prev, stuckChecks}

  if (!sample.containerRunning) {
    return {act: {action: 'hold', height: sample.height, stuckChecks, reason: 'not-running'}, next}
  }
  if (stuckChecks < STUCK_CHECKS_BEFORE_RESTART) {
    return {act: {action: 'hold', height: sample.height, stuckChecks, reason: 'below-threshold'}, next}
  }
  if (prev.restarts >= MAX_RESTARTS) {
    return {
      act: {
        action: 'escalate',
        height: sample.height,
        stuckChecks,
        restarts: prev.restarts,
        stuckSince: prev.heightSince,
      },
      next,
    }
  }
  if (prev.lastRestartAt !== null && nowMs - Date.parse(prev.lastRestartAt) < RESTART_COOLDOWN_MS) {
    return {act: {action: 'hold', height: sample.height, stuckChecks, reason: 'cooling-down'}, next}
  }

  return {
    act: {action: 'restart', height: sample.height, stuckChecks, attempt: prev.restarts + 1},
    next: {...next, restarts: prev.restarts + 1, lastRestartAt: now},
  }
}
