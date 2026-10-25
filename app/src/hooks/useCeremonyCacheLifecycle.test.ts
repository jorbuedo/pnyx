/**
 * Tests for the `useCeremonyCacheLifecycle` hook's wiring (subscribe,
 * evict, unsubscribe). The pure decision rules live in
 * `ceremony-cache-lifecycle-rules.ts` and are covered separately; this
 * file exercises the side-effects that the rules drive.
 *
 * Uses the same minimal React + react-native simulation pattern as
 * other app hook tests so the hook runs outside a real tree.
 */

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

const sim = vi.hoisted(() => ({
  states: [] as unknown[],
  stateIdx: 0,
  refs: [] as Array<{current: unknown}>,
  refIdx: 0,
  effects: [] as Array<{
    deps: unknown[] | undefined
    fn: () => (() => void) | undefined
    cleanup: (() => void) | undefined
  }>,
  effectIdx: 0,
  reset() {
    sim.states = []
    sim.stateIdx = 0
    sim.refs = []
    sim.refIdx = 0
    sim.effects = []
    sim.effectIdx = 0
  },
}))

vi.mock('react', () => ({
  useState: (init: unknown) => {
    const i = sim.stateIdx++
    if (i >= sim.states.length) sim.states.push(init)
    const setter = (v: unknown): void => {
      sim.states[i] = v
    }
    return [sim.states[i], setter]
  },
  useRef: (init: unknown) => {
    const i = sim.refIdx++
    if (i >= sim.refs.length) sim.refs.push({current: init})
    return sim.refs[i]
  },
  useEffect: (fn: () => (() => void) | undefined, deps: unknown[] | undefined) => {
    const i = sim.effectIdx++
    if (i >= sim.effects.length) {
      sim.effects.push({deps, fn, cleanup: undefined})
    } else {
      sim.effects[i] = {deps, fn, cleanup: sim.effects[i]?.cleanup}
    }
  },
}))

const appState = vi.hoisted(() => ({
  listeners: [] as Array<(state: string) => void>,
  removeMock: vi.fn(),
  emit(state: string) {
    for (const listener of appState.listeners) listener(state)
  },
  reset() {
    appState.listeners = []
    appState.removeMock.mockClear()
  },
}))

vi.mock('react-native', () => ({
  AppState: {
    addEventListener: (event: string, listener: (state: string) => void) => {
      if (event !== 'change') throw new Error(`unexpected AppState event: ${event}`)
      appState.listeners.push(listener)
      return {
        remove: () => {
          appState.removeMock()
          const idx = appState.listeners.indexOf(listener)
          if (idx >= 0) appState.listeners.splice(idx, 1)
        },
      }
    },
  },
  // The hook now evicts the Midnight sync keys too, and that store logs — which reaches
  // `platform/detect`. Mocked here rather than dropping the log: a cache holding spend-capable
  // material going quiet is the opposite of what this codebase wants.
  Platform: {OS: 'ios', select: (spec: Record<string, unknown>) => spec.ios ?? spec.default},
}))

const authStub = vi.hoisted(() => ({isUnlocked: false}))
vi.mock('../providers', () => ({
  useAuth: () => authStub,
}))

const clearAllCeremoniesMock = vi.hoisted(() => vi.fn())
vi.mock('../services/credential-vault', () => ({
  clearAllCeremonies: clearAllCeremoniesMock,
}))

// Mocked for the same reason as the vault: the real module reaches
// the Cardano rail → the logger → `react-native`, which does not resolve
// under vitest's node environment. The *rules* it obeys are tested directly in
// `identity-role-key-lifecycle-rules.test.ts` against the production predicates.
const clearIdentityRoleKeysMock = vi.hoisted(() => vi.fn())
vi.mock('../services/identity-role-keys', () => ({
  clearIdentityRoleKeys: clearIdentityRoleKeysMock,
}))

// Import AFTER mocks are registered.
import {useCeremonyCacheLifecycle} from './useCeremonyCacheLifecycle'

/** Drive a render cycle: reset hook indices, invoke the hook, then run effects. */
function render(): void {
  sim.stateIdx = 0
  sim.refIdx = 0
  sim.effectIdx = 0
  useCeremonyCacheLifecycle()
  // Run effects whose deps changed (or first run). Track cleanups for unmount.
  for (const effect of sim.effects) {
    // For this hook all effects re-run when deps change; the harness
    // doesn't track deps comparison granularity, so we re-invoke on
    // every render. The hook's effects are idempotent against that.
    if (effect.cleanup) effect.cleanup()
    const cleanup = effect.fn()
    effect.cleanup = typeof cleanup === 'function' ? cleanup : undefined
  }
}

/** Simulate unmount: run all effect cleanups, drop indices. */
function unmount(): void {
  for (const effect of sim.effects) {
    if (effect.cleanup) {
      effect.cleanup()
      effect.cleanup = undefined
    }
  }
  sim.reset()
}

beforeEach(() => {
  sim.reset()
  appState.reset()
  authStub.isUnlocked = false
  clearAllCeremoniesMock.mockClear()
  clearIdentityRoleKeysMock.mockClear()
})

afterEach(() => {
  unmount()
})

describe('useCeremonyCacheLifecycle', () => {
  it('subscribes to AppState on mount', () => {
    expect(appState.listeners).toHaveLength(0)
    render()
    expect(appState.listeners).toHaveLength(1)
  })

  it('unsubscribes from AppState on unmount', () => {
    render()
    expect(appState.listeners).toHaveLength(1)
    unmount()
    expect(appState.listeners).toHaveLength(0)
    expect(appState.removeMock).toHaveBeenCalledTimes(1)
  })

  it('evicts the cache on a background AppState transition', () => {
    render()
    appState.emit('background')
    expect(clearAllCeremoniesMock).toHaveBeenCalledTimes(1)
  })

  it('does NOT evict on inactive AppState (iOS Face ID / system modal)', () => {
    render()
    appState.emit('inactive')
    expect(clearAllCeremoniesMock).not.toHaveBeenCalled()
  })

  it('does NOT evict on active AppState', () => {
    render()
    appState.emit('active')
    expect(clearAllCeremoniesMock).not.toHaveBeenCalled()
  })

  it('does NOT evict on initial render when the user has never logged in', () => {
    authStub.isUnlocked = false
    render()
    expect(clearAllCeremoniesMock).not.toHaveBeenCalled()
  })

  it('evicts on a real true → false transition (logout)', () => {
    // First render: user is logged in. The auth-effect should remember
    // that for the next render's transition check.
    authStub.isUnlocked = true
    render()
    expect(clearAllCeremoniesMock).not.toHaveBeenCalled()

    // Second render: user has logged out. The transition fires eviction.
    authStub.isUnlocked = false
    render()
    expect(clearAllCeremoniesMock).toHaveBeenCalledTimes(1)
  })

  // The two caches have deliberately different policies (Phase 16 item 42): ID
  // role keys survive backgrounding because it is not a security event on mobile,
  // and go only when the user actually locks. These assertions exist so a later
  // "unify the eviction logic" change has to confront the decision.
  it('does NOT evict ID role keys on background, unlike the ceremony cache', () => {
    render()
    appState.emit('background')
    expect(clearAllCeremoniesMock).toHaveBeenCalledTimes(1)
    expect(clearIdentityRoleKeysMock).not.toHaveBeenCalled()
  })

  it('evicts ID role keys on lock', () => {
    authStub.isUnlocked = true
    render()
    expect(clearIdentityRoleKeysMock).not.toHaveBeenCalled()

    authStub.isUnlocked = false
    render()
    expect(clearIdentityRoleKeysMock).toHaveBeenCalledTimes(1)
  })
})
