/**
 * A latch for a background task that should run at most once — but may be retried if it failed.
 *
 * Pure logic in its own module because the behaviour worth pinning is not the "run once" half (that
 * is obvious) but the **re-arm on failure**: a warm-up that failed on a dead network must be
 * startable again, while one that is merely still running must not be started twice. A plain
 * `started = true` gets the first case wrong and nothing would notice, because the only symptom is
 * an optimisation that quietly stops happening.
 *
 * **The latch owns the failure log, and the task must not catch.** An earlier shape had the task
 * log and rethrow while this swallowed — which reads as a silent handler here and splits one error
 * path across two files. `label` names the task in that log, so a caller adds no error handling of
 * its own.
 *
 * @module
 */

import {logger} from '../../logger'

export const startOnce = (label: string, task: () => Promise<unknown>): (() => void) => {
  let started = false
  return () => {
    if (started) return
    started = true
    void task().catch((error: unknown) => {
      // `debug`, not `warn`: a background warm-up that did not finish blocks nobody — the lazy path
      // fetches the same thing on demand. But it is never nothing, or a warm-up that silently
      // stopped happening would be indistinguishable from one that worked.
      logger.debug(`${label} did not finish; it will be retried`, {
        origin: 'startOnce',
        label,
        error: String(error),
      })
      started = false
    })
  }
}
