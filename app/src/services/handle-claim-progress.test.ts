import {beforeEach, describe, expect, it, vi} from 'vitest'
import {
  claimAt,
  claimEnded,
  claimSnapshot,
  claimStarted,
  clearClaim,
  resetClaimProgress,
  subscribeToClaim,
} from './handle-claim-progress'

beforeEach(() => resetClaimProgress())

describe('claim progress', () => {
  it('reports each phase to subscribers', () => {
    const seen: (string | undefined)[] = []
    subscribeToClaim((p) => seen.push(p?.phase))
    claimStarted('amberhollow')
    claimAt('permit')
    claimAt('bind')
    expect(seen).toEqual(['shell', 'permit', 'bind'])
  })

  it('keeps a failure on screen instead of losing it to a toast', () => {
    // The reported case: a claim that failed at the relay after ~100s, where the only trace was a
    // toast that had already gone by the time anyone looked.
    claimStarted('amberhollow')
    claimEnded({kind: 'failed', reasonKey: 'you.handle.failure.relay'})
    expect(claimSnapshot()?.outcome).toEqual({kind: 'failed', reasonKey: 'you.handle.failure.relay'})
  })

  it('ignores a late phase report once the claim has ended', () => {
    // A step that resolves after the failure must not put the claim back into "in progress".
    claimStarted('amberhollow')
    claimEnded({kind: 'failed', reasonKey: 'x'})
    claimAt('awaiting-row')
    expect(claimSnapshot()?.phase).toBe('shell')
    expect(claimSnapshot()?.outcome?.kind).toBe('failed')
  })

  it('only dismisses a claim that has finished', () => {
    claimStarted('amberhollow')
    clearClaim()
    expect(claimSnapshot()?.name).toBe('amberhollow')
    claimEnded({kind: 'claimed'})
    clearClaim()
    expect(claimSnapshot()).toBeUndefined()
  })

  it('a new claim replaces a finished one still on screen', () => {
    claimStarted('first')
    claimEnded({kind: 'failed', reasonKey: 'x'})
    claimStarted('second')
    expect(claimSnapshot()).toEqual({name: 'second', phase: 'shell'})
  })

  it('phase reports before any claim are dropped rather than inventing one', () => {
    claimAt('bind')
    expect(claimSnapshot()).toBeUndefined()
  })

  it('stops notifying after unsubscribe', () => {
    const listener = vi.fn()
    subscribeToClaim(listener)()
    claimStarted('amberhollow')
    expect(listener).not.toHaveBeenCalled()
  })
})
