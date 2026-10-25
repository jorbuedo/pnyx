import {describe, expect, it} from 'vitest'
import {
  appendSignedStep,
  CONTINUATION_SCHEMA_VERSION,
  createContinuation,
  isResumable,
  markBroadcasting,
  markError,
} from './record'

const base = () =>
  createContinuation({groupId: 'g1', continuationId: 'c1', context: 'cardano.signAll', expectedStepCount: 3})

describe('continuation record', () => {
  it('starts awaiting-user with a versioned envelope and no steps', () => {
    const r = base()
    expect(r.schemaVersion).toBe(CONTINUATION_SCHEMA_VERSION)
    expect(r.status).toBe('awaiting-user')
    expect(r.signedSteps).toEqual([])
    expect(r.currentStepIndex).toBe(0)
    expect(isResumable(r)).toBe(true)
  })

  it('appendSignedStep advances the index and moves to signed while legs remain', () => {
    const r = appendSignedStep(base(), {stepId: '0', txHash: 'aa'})
    expect(r.currentStepIndex).toBe(1)
    expect(r.status).toBe('signed')
    expect(r.signedSteps).toHaveLength(1)
    expect(isResumable(r)).toBe(true)
  })

  it('reaches completed once every expected leg has landed', () => {
    let r = base()
    r = appendSignedStep(r, {stepId: '0', txHash: 'a'})
    r = appendSignedStep(r, {stepId: '1', txHash: 'b'})
    r = appendSignedStep(r, {stepId: '2', txHash: 'c'})
    expect(r.status).toBe('completed')
    expect(r.currentStepIndex).toBe(3)
    expect(isResumable(r)).toBe(false)
  })

  it('appendSignedStep is idempotent on stepId', () => {
    const once = appendSignedStep(base(), {stepId: '0', txHash: 'a'})
    const twice = appendSignedStep(once, {stepId: '0', txHash: 'a'})
    expect(twice).toBe(once)
    expect(twice.signedSteps).toHaveLength(1)
  })

  it('markBroadcasting flips awaiting-user → broadcasting but leaves terminal states', () => {
    expect(markBroadcasting(base()).status).toBe('broadcasting')
    const errored = markError(base(), 'boom')
    expect(markBroadcasting(errored).status).toBe('error')
  })

  it('markError records the reason and is terminal', () => {
    const r = markError(appendSignedStep(base(), {stepId: '0', txHash: 'a'}), 'device rejected')
    expect(r.status).toBe('error')
    expect(r.error).toBe('device rejected')
    // Prior progress is preserved for the resume surface.
    expect(r.signedSteps).toHaveLength(1)
  })

  it('carries optional returnTo / contextData when provided', () => {
    const r = createContinuation({
      groupId: 'g',
      continuationId: 'c',
      context: 'swap',
      expectedStepCount: 2,
      returnTo: '/wallet/transactions',
      contextData: {swapId: 'x'},
    })
    expect(r.returnTo).toBe('/wallet/transactions')
    expect(r.contextData).toEqual({swapId: 'x'})
  })
})
