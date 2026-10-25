/**
 * Watchdog wrapper for long-running awaits.
 *
 * Fires a `logger.warn` (captured to Sentry by the sentry transport — see
 * `./sentry.ts:96`) when the wrapped promise hasn't settled by the
 * deadline. Useful for catching silent hangs in user-visible flows
 * (onboarding's "Encrypting vault" step) where the operation
 * doesn't throw — it just never resolves and Sentry stays empty.
 *
 * The watchdog does NOT reject or alter the promise; if/when the
 * operation eventually settles, downstream `await` continues normally.
 * Only the warn is emitted, with elapsed time tagged so Sentry can
 * group "X took longer than N ms" without one issue per arbitrary
 * latency value.
 *
 * @module
 */
import {logger} from './index'

type WatchdogContext = Record<string, unknown>

type WatchdogOptions = {
  /** Stable label used as the Sentry tag and breadcrumb category. */
  readonly label: string
  /** Elapsed time (ms) at which to fire the warn. */
  readonly thresholdMs: number
  /** Additional context attached to the warn (chainId, groupId, etc). */
  readonly context?: WatchdogContext
}

/**
 * Wrap a promise with a watchdog that warns to Sentry if the deadline
 * is exceeded. Returns the same promise unchanged.
 *
 * @example
 * ```ts
 * const result = await watchdog(
 *   secureStorage.storeMnemonic(key, mnemonic, password),
 *   {label: 'storeMnemonic', thresholdMs: 15_000, context: {groupId}},
 * )
 * ```
 */
export const watchdog = <T>(promise: Promise<T>, options: WatchdogOptions): Promise<T> => {
  const start = Date.now()
  const timer = setTimeout(() => {
    logger.warn(`watchdog: ${options.label} still pending after ${options.thresholdMs}ms`, {
      origin: 'watchdog',
      label: options.label,
      thresholdMs: options.thresholdMs,
      elapsedMs: Date.now() - start,
      ...(options.context ?? {}),
    })
  }, options.thresholdMs)
  return promise.finally(() => clearTimeout(timer))
}
