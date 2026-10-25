import {router, useSegments} from 'expo-router'
import {useCallback, useEffect, useRef} from 'react'
import {AppState, type AppStateStatus} from 'react-native'
import {logger} from '../logger'
import {isNative} from '../platform'
import {storage} from '../platform/storage'
import {useAuth} from '../providers/AuthProvider'
import {markSessionLockedSync} from '../services/auth-session'
import {pendingPushIntent} from '../services/pending-push-intent'
import {requestGateLock} from '../services/profile/gate-state'
import {isArmedSync, readLockConfigSync} from '../services/profile/pin-config'
import {isPinRequired} from '../services/profile/pin-required'
import {useAutoLockTimer} from './useAutoLockTimer'
import {useLatestRef} from './useLatestRef'

const LAST_ACTIVE_KEY = '@pnyx/last_active'

export type RelockReason = 'cold-start-no-session' | 'cold-start-elapsed' | 'bg-elapsed'

export const relockToLogin = (reason: RelockReason): void => {
  // Auto-lock preserves any buffered push intent — the 5-min TTL
  // bounds staleness. Explicit logout paths use `lockSessionMirrors`
  // (clears intent). See `LOCK_STATE_SNAPSHOT_AUDIT.md`.
  const carried = pendingPushIntent.peek()
  if (carried) {
    logger.info('[lock] preserving buffered push intent across relock', {
      origin: 'useLockScreen',
      reason,
      intentKind: carried.kind,
    })
  }
  sessionAuthenticated = false
  markSessionLockedSync()

  // `everyUnlock` (and an armed manual lock) must re-challenge the profile gate,
  // which sits above this route and would otherwise never see the re-lock. The
  // biometric screen below still runs either way.
  const lockConfig = readLockConfigSync()
  if (
    lockConfig !== undefined &&
    isPinRequired({configured: true, mode: lockConfig.mode, isColdStart: false, isArmed: isArmedSync()})
  ) {
    requestGateLock()
    return
  }

  router.navigate('/(lock)/login')
}

/**
 * Resets when the JS runtime is killed (force-close from app switcher).
 * Survives background/foreground transitions within the same session.
 */
let sessionAuthenticated = false

// Flips the per-session "user has cleared the lock at least once"
// flag. The companion snapshot mirror is owned by `AuthProvider`'s
// derived effect (see `decideAuthSnapshot`) — it tracks
// `isUnlocked` and reflects the actual lock state including
// edge cases this function doesn't see (no wallets yet, wallets
// deleted mid-session, etc.).
export function markSessionAuthenticated(): void {
  sessionAuthenticated = true
}

export function useLockScreen(): void {
  const {isLockEnabled, isReady} = useAuth()
  const {timeoutMs, isReady: timerReady} = useAutoLockTimer()
  const segments = useSegments()
  const appStateRef = useRef<AppStateStatus>(AppState.currentState)
  const segmentsRef = useLatestRef(segments)

  const hasLockAuth = isLockEnabled
  const timeoutMsRef = useLatestRef(timeoutMs)

  const isOnLockScreen = useCallback(() => segmentsRef.current[0] === '(lock)', [])
  const isOnRootIndex = useCallback(() => !segmentsRef.current[0] || segmentsRef.current[0] === 'index', [])

  // Cold-start check — runs once when auth state is ready.
  // Always requires auth on fresh app launch (sessionAuthenticated === false),
  // regardless of the timer setting.
  // Does NOT depend on timeoutMs to avoid re-locking mid-session when the user changes the timer.
  useEffect(() => {
    if (!isNative || !hasLockAuth || !isReady || !timerReady) return

    const coldStartCheck = async () => {
      if (isOnLockScreen()) return

      const lastActiveRaw = await storage.get(LAST_ACTIVE_KEY)

      if (!lastActiveRaw) {
        await storage.set(LAST_ACTIVE_KEY, Date.now().toString())
        markSessionAuthenticated()
        return
      }

      // index.tsx already shows an inline lock screen — navigating to
      // /(lock)/login would stack a second auth screen on top.

      if (!sessionAuthenticated) {
        if (!isOnRootIndex()) {
          relockToLogin('cold-start-no-session')
        }
        return
      }

      const elapsed = Date.now() - parseInt(lastActiveRaw, 10)

      if (elapsed >= timeoutMsRef.current) {
        relockToLogin('cold-start-elapsed')
      }
    }

    coldStartCheck()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- timeoutMs intentionally excluded; read via ref
  }, [hasLockAuth, isReady, timerReady, isOnLockScreen, isOnRootIndex])

  // AppState listener — background/foreground transitions.
  // Reads timeoutMsRef dynamically so timer changes take effect without re-mounting.
  useEffect(() => {
    if (!isNative || !hasLockAuth || !isReady || !timerReady) return

    const handleAppStateChange = async (nextState: AppStateStatus) => {
      const previousState = appStateRef.current
      appStateRef.current = nextState

      if (previousState === 'active' && (nextState === 'inactive' || nextState === 'background')) {
        if (!isOnLockScreen()) {
          await storage.set(LAST_ACTIVE_KEY, Date.now().toString())
        }
        return
      }

      // inactive→active — iOS fires this when dismissing system dialogs
      // (Face ID, permission prompts, notification center). Never lock here;
      // ctrl-mobile does the same: only hides the logo overlay on this transition.
      if (previousState === 'inactive' && nextState === 'active') {
        return
      }

      if (previousState === 'background' && nextState === 'active') {
        if (isOnLockScreen()) return

        const lastActiveRaw = await storage.get(LAST_ACTIVE_KEY)
        if (!lastActiveRaw) return

        const elapsed = Date.now() - parseInt(lastActiveRaw, 10)

        if (elapsed >= timeoutMsRef.current) {
          relockToLogin('bg-elapsed')
        }
      }
    }

    const subscription = AppState.addEventListener('change', handleAppStateChange)
    return () => subscription.remove()
  }, [hasLockAuth, isReady, timerReady, isOnLockScreen])
}
