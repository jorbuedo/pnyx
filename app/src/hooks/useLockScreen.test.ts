import {beforeEach, describe, expect, it, vi} from 'vitest'
import {__resetAuthSessionSnapshotForTests, authSessionSnapshot} from '../services/auth-session'
import {__resetPendingPushIntentForTests, pendingPushIntent} from '../services/pending-push-intent'

const {navigate} = vi.hoisted(() => ({
  navigate: vi.fn(),
}))

vi.mock('expo-router', () => ({
  router: {navigate},
  useSegments: () => [],
}))

vi.mock('react', () => ({
  useCallback: (fn: unknown) => fn,
  useEffect: () => undefined,
  useRef: (init: unknown) => ({current: init}),
}))

vi.mock('react-native', () => ({
  AppState: {
    currentState: 'active',
    addEventListener: () => ({remove: () => undefined}),
  },
  Platform: {OS: 'ios', select: <T>(opts: {readonly ios?: T; readonly default?: T}) => opts.ios ?? opts.default},
}))

vi.mock('../platform', () => ({isNative: true}))
// `deviceStorage` too: `relockToLogin` reads the lock configuration to decide
// whether a re-lock must re-challenge the profile gate rather than just show
// the biometric screen. `getSync: () => null` means "no PIN configured", which
// is the case these tests cover — the plain navigate-to-lock path.
vi.mock('../platform/storage', () => ({
  storage: {getSync: () => null, get: vi.fn(), set: vi.fn(), remove: vi.fn()},
  deviceStorage: {getSync: () => null, get: vi.fn(), set: vi.fn(), remove: vi.fn()},
}))
vi.mock('../providers/AuthProvider', () => ({
  useAuth: () => ({isLockEnabled: true, hasWallets: true, isReady: true}),
}))
vi.mock('./useAutoLockTimer', () => ({useAutoLockTimer: () => ({timeoutMs: 300_000, isReady: true})}))

const {relockToLogin} = await import('./useLockScreen')

describe('relockToLogin', () => {
  beforeEach(() => {
    navigate.mockClear()
    __resetAuthSessionSnapshotForTests()
    __resetPendingPushIntentForTests()
  })

  it('marks the session locked and navigates to /(lock)/login — intent preserved (auto-lock semantics)', () => {
    authSessionSnapshot.markUnlocked()
    pendingPushIntent.set({kind: 'card-3ds', txId: 'tx-buffered', createdAtMs: Date.now()})

    relockToLogin('bg-elapsed')

    expect(authSessionSnapshot.isUnlocked).toBe(false)
    expect(pendingPushIntent.peek()).toMatchObject({kind: 'card-3ds', txId: 'tx-buffered'})
    expect(navigate).toHaveBeenCalledWith('/(lock)/login')
  })

  it('is safe to call when nothing is set (idempotent)', () => {
    relockToLogin('cold-start-no-session')
    expect(authSessionSnapshot.isUnlocked).toBe(false)
    expect(pendingPushIntent.peek()).toBeNull()
    expect(navigate).toHaveBeenCalledWith('/(lock)/login')
  })

  it('accepts each documented reason without throwing', () => {
    relockToLogin('cold-start-no-session')
    relockToLogin('cold-start-elapsed')
    relockToLogin('bg-elapsed')
    expect(navigate).toHaveBeenCalledTimes(3)
  })

  it('preserves intent across all three relock reasons (auto-lock should not drop deep links)', () => {
    for (const reason of ['cold-start-no-session', 'cold-start-elapsed', 'bg-elapsed'] as const) {
      __resetAuthSessionSnapshotForTests()
      __resetPendingPushIntentForTests()
      pendingPushIntent.set({kind: 'card-3ds', txId: `tx-${reason}`, createdAtMs: Date.now()})
      relockToLogin(reason)
      expect(pendingPushIntent.peek()).toMatchObject({kind: 'card-3ds', txId: `tx-${reason}`})
    }
  })
})
