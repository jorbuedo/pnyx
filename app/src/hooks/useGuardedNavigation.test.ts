/**
 * Tests for useGuardedNavigation.
 *
 * Uses the minimal React + expo-router hook simulation also used by
 * useCardDetailsRevealFlow.test.ts so the hook runs outside a real React tree.
 *
 * @module
 */

import {beforeEach, describe, expect, it, vi} from 'vitest'

const {sim} = vi.hoisted(() => ({
  sim: {
    states: [] as unknown[],
    stateIdx: 0,
    refs: [] as Array<{current: unknown}>,
    refIdx: 0,
    focusEffects: [] as Array<() => void>,
  },
}))

vi.mock('react', () => ({
  useState: (init: unknown) => {
    const i = sim.stateIdx++
    if (i >= sim.states.length) sim.states.push(init)
    return [
      sim.states[i],
      (v: unknown) => {
        // biome-ignore lint/complexity/noBannedTypes: test-only React mock needs generic callable cast
        sim.states[i] = typeof v === 'function' ? (v as Function)(sim.states[i]) : v
      },
    ]
  },
  useCallback: (fn: unknown) => fn,
  useMemo: (factory: () => unknown) => factory(),
  useRef: (init: unknown) => {
    const i = sim.refIdx++
    if (i >= sim.refs.length) sim.refs.push({current: init})
    return sim.refs[i]
  },
}))

vi.mock('expo-router', () => ({
  // Capture the focus callback so tests can fire focus return on demand.
  useFocusEffect: (fn: () => void) => {
    sim.focusEffects.push(fn)
  },
}))

import {useGuardedNavigation} from './useGuardedNavigation'

function resetAll() {
  sim.states = []
  sim.refs = []
  sim.stateIdx = 0
  sim.refIdx = 0
  sim.focusEffects = []
}

function render() {
  sim.stateIdx = 0
  sim.refIdx = 0
  sim.focusEffects = []
  return useGuardedNavigation()
}

describe('useGuardedNavigation', () => {
  beforeEach(resetAll)

  it('runs the wrapped fn the first time and drops re-entrant calls', () => {
    const fn = vi.fn()
    const {guard} = render()

    guard(fn)
    guard(fn)
    guard(fn)

    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('reports isNavigating=true after a successful guard call', () => {
    const fn = vi.fn()
    const first = render()
    expect(first.isNavigating).toBe(false)

    first.guard(fn)
    const second = render()
    expect(second.isNavigating).toBe(true)
  })

  it('re-arms after manual reset', () => {
    const fn = vi.fn()
    const hook = render()

    hook.guard(fn)
    hook.guard(fn)
    expect(fn).toHaveBeenCalledTimes(1)

    hook.reset()
    hook.guard(fn)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('re-arms when the screen regains focus', () => {
    const fn = vi.fn()
    const hook = render()

    hook.guard(fn)
    hook.guard(fn)
    expect(fn).toHaveBeenCalledTimes(1)

    // Simulate focus return — useFocusEffect callback fires.
    expect(sim.focusEffects).toHaveLength(1)
    sim.focusEffects[0]?.()

    hook.guard(fn)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('resets on synchronous throw and rethrows the error', () => {
    const err = new Error('boom')
    const hook = render()

    expect(() =>
      hook.guard(() => {
        throw err
      }),
    ).toThrow(err)

    // Guard released — second call is allowed.
    const fn = vi.fn()
    hook.guard(fn)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('resets on async rejection without surfacing the error as unhandled', async () => {
    const err = new Error('async boom')
    const hook = render()

    hook.guard(() => Promise.reject(err))
    // Yield so the `.catch(reset)` chain runs.
    await Promise.resolve()
    await Promise.resolve()

    const fn = vi.fn()
    hook.guard(fn)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('tryEnter acquires once and rejects further attempts until reset', () => {
    const hook = render()

    expect(hook.tryEnter()).toBe(true)
    expect(hook.tryEnter()).toBe(false)

    hook.reset()
    expect(hook.tryEnter()).toBe(true)
  })

  it('keeps the guard armed when the wrapped async fn resolves', async () => {
    const hook = render()
    let resolved = false
    hook.guard(async () => {
      resolved = true
    })
    await Promise.resolve()
    expect(resolved).toBe(true)

    const dropped = vi.fn()
    hook.guard(dropped)
    expect(dropped).not.toHaveBeenCalled()
  })
})
