/**
 * "Lock now" — arm the gate and drop the session.
 *
 * The armed flag is written to device-global storage rather than held in
 * memory, because it must survive a force-quit: someone killing the app from
 * the switcher must not be able to clear it. (`sessionAuthenticated` in
 * `useLockScreen` is a module-level `let` and does reset on force-quit — fine
 * for re-locking, not sufficient here.)
 *
 * @module
 */

import {useCallback, useSyncExternalStore} from 'react'
import {logger} from '../logger'
import {useAuth} from '../providers/AuthProvider'
import {requestGateLock} from '../services/profile/gate-state'
import {readLockConfigSync, setArmed, subscribeLockConfig} from '../services/profile/pin-config'

export type ManualLock = {
  /** True when a PIN exists — the lock button is shown on exactly this. */
  readonly canLock: boolean
  readonly lockNow: () => Promise<void>
}

const getCanLockSnapshot = (): boolean => readLockConfigSync() !== undefined

export function useManualLock(): ManualLock {
  const {lockSession} = useAuth()
  // A live read, not a mount-time snapshot: every tab keeps its own AppTopBar
  // instance, and one mounted before the PIN was set would otherwise never show
  // the lock button until it remounted (MMKV does not notify React).
  const canLock = useSyncExternalStore(subscribeLockConfig, getCanLockSnapshot)

  const lockNow = useCallback(async () => {
    // Persist the arm before dropping the session: if the process dies between
    // the two, the next open must still ask.
    await setArmed(true).catch((error: unknown) => {
      logger.warn('[ManualLock] could not persist armed flag', {origin: 'ManualLock', error: String(error)})
    })
    lockSession()
    // The gate lives above the lock route, so navigating there is not enough —
    // it has to be told to challenge again.
    requestGateLock()
  }, [lockSession])

  return {canLock, lockNow}
}
