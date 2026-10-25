import {pendingPushIntent} from './pending-push-intent'

export type AuthSnapshotInput = {
  readonly isReady: boolean
  readonly isLockEnabled: boolean
  readonly isUnlocked: boolean
  readonly isOnLockSegment: boolean
}

export type AuthSnapshotDecision = 'unlocked' | 'locked' | 'unknown'

export const decideAuthSnapshot = (input: AuthSnapshotInput): AuthSnapshotDecision => {
  if (!input.isReady) return 'unknown'
  if (input.isOnLockSegment) return 'locked'
  if (!input.isLockEnabled) return 'unlocked'
  return input.isUnlocked ? 'unlocked' : 'locked'
}

let isUnlocked = false

export const authSessionSnapshot = {
  get isUnlocked(): boolean {
    return isUnlocked
  },
  markUnlocked(): void {
    isUnlocked = true
  },
  markLocked(): void {
    isUnlocked = false
  },
}

/**
 * The lock state a freshly-mounted `AuthProvider` must start in.
 *
 * ⚠️ **Not `false`.** The provider sits inside the tree keyed on the funds network, so a
 * mainnet→preview switch remounts it — and starting locked re-challenged a user who had already
 * authenticated this process, for a switch that changes nothing about the identity or its enclave
 * gate. The mirror is the process-wide record of that authentication, and every real lock path clears
 * it ({@link lockSessionMirrors}, {@link markSessionLockedSync}), so a lock still leaves the next
 * mount locked.
 */
export const initialSessionUnlocked = (): boolean => authSessionSnapshot.isUnlocked

export const lockSessionMirrors = (): void => {
  authSessionSnapshot.markLocked()
  pendingPushIntent.clear()
}

export const markSessionLockedSync = (): void => {
  authSessionSnapshot.markLocked()
}

export const __resetAuthSessionSnapshotForTests = (): void => {
  isUnlocked = false
}
