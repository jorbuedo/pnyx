/**
 * Auth provider — enclave-native session lock.
 *
 * There is no app-level password or PIN. Seed material lives in the OS
 * keychain (enclave vault, `BIOMETRY_ANY_OR_DEVICE_PASSCODE`) and the app
 * lock is a session flag cleared by the OS biometric / device-passcode
 * prompt on the lock screen. The lock is active whenever wallets exist.
 *
 * @module
 */

import {useSegments} from 'expo-router'
import {createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState} from 'react'
import {logger} from '../logger'
import {isNative} from '../platform'
import {storage} from '../platform/storage'
import {
  authSessionSnapshot,
  decideAuthSnapshot,
  initialSessionUnlocked,
  lockSessionMirrors,
} from '../services/auth-session'
import {useWalletCore, useWalletList} from './WalletProvider'

type AuthContextValue = {
  readonly isReady: boolean
  readonly hasWallets: boolean
  /** App lock is active whenever wallets exist (mobile only). */
  readonly isLockEnabled: boolean
  /** Session flag — flipped by a successful OS auth on the lock screen. */
  readonly isUnlocked: boolean
  readonly unlockSession: () => void
  readonly lockSession: () => void
  /** Clears auth-adjacent persisted state. Used by the wipe-and-restore recovery flow. */
  readonly resetAllAuth: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export type AuthProviderProps = {
  children: ReactNode
}

export function AuthProvider({children}: AuthProviderProps) {
  const {isReady: walletReady} = useWalletCore()
  const {wallets} = useWalletList()
  const hasWallets = wallets.length > 0

  const isReady = walletReady
  const isLockEnabled = isNative && hasWallets

  // Seeded from the process-wide mirror rather than `false`: this provider remounts on a funds-network
  // switch, and the rule for what that must mean lives in `initialSessionUnlocked`.
  const [isUnlocked, setIsUnlocked] = useState(initialSessionUnlocked)
  const unlockSession = useCallback(() => setIsUnlocked(true), [])
  const lockSession = useCallback(() => {
    setIsUnlocked(false)
    lockSessionMirrors()
  }, [])

  const resetAllAuth = useCallback(async (): Promise<void> => {
    setIsUnlocked(false)
    lockSessionMirrors()

    // Init flags
    await storage.remove('@pnyx/init_new_or_return_done')
    await storage.remove('@pnyx/security_settings_seen')

    // DApp state — sessions, bookmarks, browsing history (legacy keys)
    await storage.remove('@pnyx/dapp/sessions')
    await storage.remove('@pnyx/dapp/bookmarks')
    await storage.remove('@pnyx/dapp/history')

    // Signing history — a full reset removes the wallets, so records of signatures by
    // wallets that no longer exist are dead data. Cleared here, never on lock.
    await storage.remove('@pnyx/signing/audit')

    // Activity timestamps used by lock screen
    await storage.remove('@pnyx/last_active')
    await storage.remove('@pnyx/auto_lock_timer')

    logger.info('All auth state reset', {origin: 'AuthProvider'})
  }, [])

  const hasLoggedInit = useRef(false)
  useEffect(() => {
    if (!isReady || hasLoggedInit.current) return
    hasLoggedInit.current = true
    logger.info('Auth provider initialized', {origin: 'AuthProvider', isLockEnabled})
  }, [isReady, isLockEnabled])

  // Snapshot derivation runs on every (isReady, isLockEnabled, isUnlocked,
  // isOnLockSegment) change. The `(lock)` segment bit covers auto-lock:
  // `relockToLogin` doesn't flip `isUnlocked` — without the segment input
  // the snapshot would read unlocked while the user is on `/(lock)/login`.
  const segments = useSegments()
  const isOnLockSegment = segments[0] === '(lock)'
  useEffect(() => {
    const decision = decideAuthSnapshot({isReady, isLockEnabled, isUnlocked, isOnLockSegment})
    if (decision === 'unlocked') authSessionSnapshot.markUnlocked()
    else if (decision === 'locked') authSessionSnapshot.markLocked()
    // 'unknown' leaves the snapshot untouched.
  }, [isReady, isLockEnabled, isUnlocked, isOnLockSegment])

  const value = useMemo<AuthContextValue>(
    () => ({
      isReady,
      hasWallets,
      isLockEnabled,
      isUnlocked,
      unlockSession,
      lockSession,
      resetAllAuth,
    }),
    [isReady, hasWallets, isLockEnabled, isUnlocked, unlockSession, lockSession, resetAllAuth],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export const useAuth = (): AuthContextValue => {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return context
}
