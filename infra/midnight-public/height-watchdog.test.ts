import {describe, expect, it} from 'vitest'
import {
  decide,
  INITIAL_STATE,
  MAX_RESTARTS,
  RESTART_COOLDOWN_MS,
  type Sample,
  STUCK_CHECKS_BEFORE_RESTART,
  type WatchdogState,
} from './height-watchdog'

const T0 = Date.parse('2026-10-15T03:00:00.000Z')
const min = (n: number): number => n * 60_000
const up = (height: number): Sample => ({readable: true, height, containerRunning: true})

type Step = {act: ReturnType<typeof decide>['act']; state: WatchdogState}

/** Drive a sequence of samples five minutes apart, as launchd does, and return every action. */
const drive = (samples: Sample[], from: WatchdogState = INITIAL_STATE): Step[] => {
  let state = from
  return samples.map((s, i) => {
    const {act, next} = decide(state, s, T0 + min(5 * i))
    state = next
    return {act, state}
  })
}

/** `noUncheckedIndexedAccess` is on: assert the step exists rather than threading `?.` everywhere. */
const at = (steps: Step[], i: number): Step => {
  const step = steps[i]
  if (step === undefined) throw new Error(`no step ${i} of ${steps.length}`)
  return step
}

describe('decide', () => {
  it('reports the first sample without judging it', () => {
    const first = at(drive([up(3_018_825)]), 0)
    expect(first.act).toEqual({action: 'first-sample', height: 3_018_825})
    expect(first.state.stuckChecks).toBe(0)
  })

  it('reports advancing and keeps the stall count at zero', () => {
    const steps = drive([up(3_018_825), up(3_018_875), up(3_018_925)])
    expect(at(steps, 1).act).toEqual({action: 'advancing', from: 3_018_825, to: 3_018_875, gained: 50})
    expect(at(steps, 2).act.action).toBe('advancing')
    expect(at(steps, 2).state.stuckChecks).toBe(0)
  })

  // The 2026-10-15 outage: height frozen at 3,018,825 for 17 hours while every other signal read
  // healthy. Two stuck checks is ~10 minutes, and mainnet makes ~50 blocks in five.
  it('holds once then restarts, reproducing the 17-hour stall', () => {
    const steps = drive([up(3_018_825), up(3_018_825), up(3_018_825)])
    expect(at(steps, 1).act).toEqual({action: 'hold', height: 3_018_825, stuckChecks: 1, reason: 'below-threshold'})
    expect(at(steps, 2).act).toEqual({action: 'restart', height: 3_018_825, stuckChecks: 2, attempt: 1})
    expect(at(steps, 2).state.restarts).toBe(1)
  })

  it('does not restart before the threshold', () => {
    const steps = drive(Array.from({length: STUCK_CHECKS_BEFORE_RESTART}, () => up(100)))
    expect(steps.map((s) => s.act.action)).not.toContain('restart')
  })

  it('holds instead of restarting again inside the cooldown', () => {
    let state: WatchdogState = {
      height: 100,
      heightSince: new Date(T0).toISOString(),
      stuckChecks: 5,
      restarts: 1,
      lastRestartAt: new Date(T0).toISOString(),
    }
    const inside = decide(state, up(100), T0 + RESTART_COOLDOWN_MS - 1)
    expect(inside.act).toEqual({action: 'hold', height: 100, stuckChecks: 6, reason: 'cooling-down'})
    state = inside.next
    const after = decide(state, up(100), T0 + RESTART_COOLDOWN_MS + 1)
    expect(after.act.action).toBe('restart')
    expect(after.act.action === 'restart' && after.act.attempt).toBe(2)
  })

  it('escalates rather than restarting forever', () => {
    const state: WatchdogState = {
      height: 100,
      heightSince: new Date(T0).toISOString(),
      stuckChecks: 9,
      restarts: MAX_RESTARTS,
      lastRestartAt: new Date(T0).toISOString(),
    }
    const {act} = decide(state, up(100), T0 + min(600))
    expect(act).toEqual({
      action: 'escalate',
      height: 100,
      stuckChecks: 10,
      restarts: MAX_RESTARTS,
      stuckSince: new Date(T0).toISOString(),
    })
  })

  it('escalation outranks the cooldown, so a wedged indexer is never silently held', () => {
    const state: WatchdogState = {
      height: 100,
      heightSince: new Date(T0).toISOString(),
      stuckChecks: 9,
      restarts: MAX_RESTARTS,
      lastRestartAt: new Date(T0).toISOString(),
    }
    expect(decide(state, up(100), T0 + 1).act.action).toBe('escalate')
  })

  it('leaves a container somebody stopped alone', () => {
    const steps = drive([
      {readable: true, height: 100, containerRunning: false},
      {readable: true, height: 100, containerRunning: false},
      {readable: true, height: 100, containerRunning: false},
    ])
    expect(steps.map((s) => s.act.action)).toEqual(['first-sample', 'hold', 'hold'])
    expect(at(steps, 2).act).toMatchObject({reason: 'not-running'})
  })

  // A flaky `podman exec` must not look like a stall, or the watchdog restarts a healthy indexer.
  it('never counts an unreadable sample as stuck, and does not lose the stall count either', () => {
    const steps = drive([
      up(3_018_825),
      {readable: false, error: 'height query failed: connection refused'},
      {readable: false, error: 'inspect failed: no such container'},
      up(3_018_825),
    ])
    expect(at(steps, 1).act).toMatchObject({action: 'unreadable'})
    expect(at(steps, 1).state.stuckChecks).toBe(0)
    expect(at(steps, 2).state.stuckChecks).toBe(0)
    // The next readable sample still compares against the pre-outage height.
    expect(at(steps, 3).act).toEqual({action: 'hold', height: 3_018_825, stuckChecks: 1, reason: 'below-threshold'})
  })

  it('an unreadable run never issues a restart however long it persists', () => {
    const steps = drive(Array.from({length: 20}, () => ({readable: false as const, error: 'boom'})))
    expect(steps.map((s) => s.act.action)).not.toContain('restart')
  })

  it('treats a height that went backwards as movement, reported as a negative gain', () => {
    const steps = drive([up(3_018_825), up(2_000_000)])
    expect(at(steps, 1).act).toEqual({action: 'advancing', from: 3_018_825, to: 2_000_000, gained: -1_018_825})
  })

  it('movement clears the restart budget so a later stall gets its own', () => {
    const stalled: WatchdogState = {
      height: 100,
      heightSince: new Date(T0).toISOString(),
      stuckChecks: 9,
      restarts: MAX_RESTARTS,
      lastRestartAt: new Date(T0).toISOString(),
    }
    const moved = decide(stalled, up(200), T0 + min(5))
    expect(moved.next.restarts).toBe(0)
    expect(moved.next.lastRestartAt).toBeNull()
    const again = decide(moved.next, up(200), T0 + min(10))
    expect(decide(again.next, up(200), T0 + min(15)).act.action).toBe('restart')
  })
})
