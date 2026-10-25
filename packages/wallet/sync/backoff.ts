/**
 * Exponential backoff with jitter.
 *
 * @module
 */

/**
 * Backoff state for tracking retry attempts.
 */
export type BackoffState = {
  readonly attempt: number
  readonly lastAttempt?: Date
  readonly nextDelay: number
}

/**
 * Backoff configuration.
 */
export type BackoffConfig = {
  readonly initial: number
  readonly max: number
  readonly multiplier: number
}

/**
 * Default backoff configuration.
 */
export const DEFAULT_BACKOFF_CONFIG: BackoffConfig = {
  initial: 1000, // 1 second
  max: 60000, // 1 minute
  multiplier: 2,
}

/**
 * Create initial backoff state.
 */
export const createBackoffState = (): BackoffState => ({
  attempt: 0,
  nextDelay: 0,
})

/**
 * Calculate next backoff delay with jitter.
 *
 * Formula: min(initial * multiplier^attempt, max) * (0.5 + random())
 *
 * The jitter factor (0.5 + random()) gives a range of 0.5x to 1.5x
 * the base delay, helping to spread out retries and avoid thundering herd.
 */
export const calculateBackoff = (
  state: BackoffState,
  config: BackoffConfig = DEFAULT_BACKOFF_CONFIG,
): {delay: number; nextState: BackoffState} => {
  const baseDelay = Math.min(config.initial * config.multiplier ** state.attempt, config.max)

  // Add jitter: multiply by 0.5 to 1.5
  const jitter = 0.5 + Math.random()
  const delay = Math.floor(baseDelay * jitter)

  return {
    delay,
    nextState: {
      attempt: state.attempt + 1,
      lastAttempt: new Date(),
      nextDelay: delay,
    },
  }
}

/**
 * Reset backoff state after successful operation.
 */
export const resetBackoff = (state: BackoffState): BackoffState => {
  const result: BackoffState = {
    attempt: 0,
    nextDelay: 0,
  }
  if (state.lastAttempt) {
    ;(result as {lastAttempt?: Date}).lastAttempt = state.lastAttempt
  }
  return result
}

/**
 * Check if we should retry based on max attempts.
 */
export const shouldRetry = (state: BackoffState, maxAttempts: number): boolean => state.attempt < maxAttempts

/**
 * Create a delay promise for backoff.
 */
export const backoffDelay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Execute with exponential backoff.
 *
 * @param fn - Function to execute
 * @param config - Backoff configuration
 * @param maxAttempts - Maximum number of attempts
 * @returns Result of function or throws last error
 */
export const withBackoff = async <T>(
  fn: () => Promise<T>,
  config: BackoffConfig = DEFAULT_BACKOFF_CONFIG,
  maxAttempts = 5,
): Promise<T> => {
  let state = createBackoffState()
  let lastError: unknown

  while (shouldRetry(state, maxAttempts)) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      const {delay, nextState} = calculateBackoff(state, config)
      state = nextState

      if (!shouldRetry(state, maxAttempts)) {
        break
      }

      await backoffDelay(delay)
    }
  }

  throw lastError
}
