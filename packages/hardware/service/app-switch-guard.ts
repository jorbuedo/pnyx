/**
 * Tracks in-flight Ledger app switches. A Nano S re-enumerates USB on app
 * switch, firing a spurious WebHID disconnect; the provider's disconnect
 * listener checks `isActive()` so it doesn't tear the session down mid-switch.
 * Depth counter (not a boolean) because switches nest via reconnect-retry and
 * `ensureApp`.
 *
 * @module
 */

export type AppSwitchGuard = {
  readonly enter: () => void
  readonly exit: () => void
  readonly isActive: () => boolean
}

export const createAppSwitchGuard = (): AppSwitchGuard => {
  let depth = 0
  return {
    enter: () => {
      depth += 1
    },
    exit: () => {
      depth = Math.max(0, depth - 1)
    },
    isActive: () => depth > 0,
  }
}
