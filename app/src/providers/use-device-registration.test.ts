/**
 * Tests for the session↔device-registration binding: register on session
 * start, re-register on FCM token rotation while signed in, unsubscribe on
 * sign-out / session change.
 *
 * Uses the minimal React hook simulation also used by
 * use-pnyx-session-state.test.ts (extended with effect cleanups, which this
 * hook relies on for the rotation unsubscribe).
 */

import {beforeEach, describe, expect, it, vi} from 'vitest'

type EffectEntry = {deps: unknown[] | undefined; cleanup: (() => void) | undefined}

const {sim} = vi.hoisted(() => ({
  sim: {
    effects: [] as EffectEntry[],
    effectIdx: 0,
  },
}))

vi.mock('react', () => ({
  // Deps-aware with cleanup: mirrors React — a changed-deps re-run cleans up
  // the previous effect first.
  useEffect: (fn: () => undefined | (() => void), deps: unknown[] | undefined) => {
    const i = sim.effectIdx++
    const prev = sim.effects[i]
    const changed =
      prev === undefined ||
      deps === undefined ||
      prev.deps === undefined ||
      deps.length !== prev.deps.length ||
      deps.some((d, k) => !Object.is(d, prev.deps?.[k]))
    if (!changed) return
    prev?.cleanup?.()
    sim.effects[i] = {deps, cleanup: fn() ?? undefined}
  },
}))

const {registerDeviceWithService, onFcmTokenRefresh, unsubscribe} = vi.hoisted(() => ({
  registerDeviceWithService: vi.fn(async () => true),
  onFcmTokenRefresh: vi.fn(),
  unsubscribe: vi.fn(),
}))

vi.mock('../services/device-registration', () => ({registerDeviceWithService}))
vi.mock('../platform/firebase', () => ({onFcmTokenRefresh}))

import type {PnyxSession} from '../services/pnyx-session'
import {useDeviceRegistration} from './use-device-registration'

const session = (token: string): PnyxSession => ({
  token,
  identity: 'pnyx_id_undeployed1…',
  network: 'undeployed',
  receivedAtMs: 1_700_000_000_000,
})

const render = (s: PnyxSession | undefined) => {
  sim.effectIdx = 0
  useDeviceRegistration(s)
}

beforeEach(() => {
  vi.clearAllMocks()
  sim.effects = []
  sim.effectIdx = 0
  onFcmTokenRefresh.mockReturnValue(unsubscribe)
})

describe('useDeviceRegistration', () => {
  it('does nothing without a session', () => {
    render(undefined)

    expect(registerDeviceWithService).not.toHaveBeenCalled()
    expect(onFcmTokenRefresh).not.toHaveBeenCalled()
  })

  it('registers once when a session appears and not again on re-render', () => {
    const s = session('jwt-1')
    render(s)
    render(s)

    // The whole session, not just its JWT: binding a push token requires signing with a key
    // re-derived from the session's `forumRoot`, which the token alone cannot supply.
    expect(registerDeviceWithService).toHaveBeenCalledExactlyOnceWith(s)
    expect(onFcmTokenRefresh).toHaveBeenCalledOnce()
  })

  it('re-registers with the rotated token while signed in', () => {
    const s = session('jwt-1')
    render(s)

    const listener = onFcmTokenRefresh.mock.calls[0]?.[0] as (token: string) => void
    listener('rotated-fcm-token')

    expect(registerDeviceWithService).toHaveBeenCalledTimes(2)
    expect(registerDeviceWithService).toHaveBeenLastCalledWith(s, 'rotated-fcm-token')
  })

  it('unsubscribes from rotation on sign-out', () => {
    const s = session('jwt-1')
    render(s)
    render(undefined)

    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(registerDeviceWithService).toHaveBeenCalledExactlyOnceWith(s)
  })

  it('re-binds registration and rotation to a new session', () => {
    const second = session('jwt-2')
    render(session('jwt-1'))
    render(second)

    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(registerDeviceWithService).toHaveBeenCalledTimes(2)
    expect(registerDeviceWithService).toHaveBeenLastCalledWith(second)

    const latestListener = onFcmTokenRefresh.mock.calls[1]?.[0] as (token: string) => void
    latestListener('rotated-fcm-token')
    expect(registerDeviceWithService).toHaveBeenLastCalledWith(second, 'rotated-fcm-token')
  })
})
