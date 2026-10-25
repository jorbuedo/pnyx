/**
 * Gate open/closed signalling.
 *
 * Module-level rather than context because both readers sit *outside* anything
 * the gate provides: the deep-link buffer is mounted above it, and a `Linking`
 * callback has no React scope at all.
 *
 * It also carries the re-lock signal. The gate mounts once, above the provider
 * tree; a warm re-lock navigates to `(lock)/login`, which is a route *below*
 * the gate and cannot re-render it. Without this, `everyUnlock` and the manual
 * lock would only ever apply on a cold start — the PIN would look configured
 * and do nothing.
 *
 * @module
 */

let open = false

type Listener = () => void
const listeners = new Set<Listener>()

/** Set when a re-lock has asked the gate to demand a PIN again. */
let relockRequested = false

export const markGateOpen = (): void => {
  open = true
}

export const markGateClosed = (): void => {
  open = false
}

/** True once a profile is mounted and the normal deep-link handler is live. */
export const isGateOpen = (): boolean => open

/**
 * Ask the gate to challenge again. Safe to call from anywhere, including
 * outside React.
 */
export const requestGateLock = (): void => {
  relockRequested = true
  open = false
  for (const listener of listeners) listener()
}

export const consumeGateLockRequest = (): boolean => {
  const requested = relockRequested
  relockRequested = false
  return requested
}

export const isGateLockRequested = (): boolean => relockRequested

export const subscribeGateLock = (listener: Listener): (() => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Test seam. */
export const __resetGateStateForTests = (): void => {
  open = false
  relockRequested = false
  listeners.clear()
}
