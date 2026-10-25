import {Plan} from '@evolution-sdk/plan'
import {describe, expect, it} from 'vitest'
import {classifyBuildFailure} from './build-failure'

describe('classifyBuildFailure', () => {
  it('maps a real InsufficientError to insufficient-funds', () => {
    expect(classifyBuildFailure(new Plan.InsufficientError()).kind).toBe('insufficient-funds')
  })

  it('maps the audit H-2 fee-fold refusal to unsafe-params', () => {
    // The balancer refused to turn this much change into fee.
    const err = new Plan.ExcessiveFeeFoldError(998_830_000n)
    expect(classifyBuildFailure(err).kind).toBe('unsafe-params')
    expect(classifyBuildFailure(err).reason).toContain('refusing to fold')
  })

  it('maps structurally invalid protocol params to unsafe-params', () => {
    const err = new Plan.InvalidParamsError('coinsPerUtxoByte', 'must be non-negative, got -1')
    expect(classifyBuildFailure(err).kind).toBe('unsafe-params')
  })

  it('falls back to insufficient-funds for a flattened BuildError that says so', () => {
    // buildPlan* discard the cause's tag, so the message is all that survives.
    const err = new Plan.BuildError({reason: 'insufficient funds/assets to cover outputs + fee + deposit'})
    expect(classifyBuildFailure(err).kind).toBe('insufficient-funds')
  })

  it('treats any other flattened BuildError as build-failed', () => {
    expect(classifyBuildFailure(new Plan.BuildError({reason: 'something else went wrong'})).kind).toBe('build-failed')
  })

  it('treats an untagged error as build-failed and keeps its message', () => {
    expect(classifyBuildFailure(new Error('boom'))).toEqual({kind: 'build-failed', reason: 'boom'})
  })

  it('survives a non-Error throw', () => {
    expect(classifyBuildFailure('nope')).toEqual({kind: 'build-failed', reason: 'nope'})
  })

  it('does not classify a fee-fold refusal as insufficient funds', () => {
    // Regression guard: the old `reason.includes('insufficient')` check ran first
    // and this message contains "untrusted", not "insufficient" — but a future
    // wording change must not silently land it in the funds bucket.
    expect(classifyBuildFailure(new Plan.ExcessiveFeeFoldError(1n)).kind).not.toBe('insufficient-funds')
  })
})
