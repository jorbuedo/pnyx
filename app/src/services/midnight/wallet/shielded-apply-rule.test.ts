import {describe, expect, it} from 'vitest'

import {applyDecision} from './shielded-apply-rule'

describe('applyDecision', () => {
  it('applies every section of a fully successful transaction', () => {
    expect(applyDecision({status: 'SUCCESS'})).toEqual({apply: true, segments: 'all'})
  })

  it('applies only the successful segments of a partial success', () => {
    const decision = applyDecision({
      status: 'PARTIAL_SUCCESS',
      segments: [
        {id: 1, success: true},
        {id: 2, success: false},
        {id: 3, success: true},
      ],
    })
    expect(decision).toEqual({apply: true, segments: [1, 3]})
  })

  it('still applies the guaranteed section when every fallible segment failed', () => {
    // The guaranteed section is where a payment to us usually is, and it succeeded by definition —
    // the transaction is in a block.
    expect(applyDecision({status: 'PARTIAL_SUCCESS', segments: [{id: 1, success: false}]})).toEqual({
      apply: true,
      segments: [],
    })
  })

  it('skips a failed transaction entirely rather than applying it guaranteed-only', () => {
    // FAILURE means the guaranteed section itself failed, so the ledger applied none of it.
    expect(applyDecision({status: 'FAILURE'})).toEqual({apply: false})
  })

  it('skips a status this build does not recognise', () => {
    expect(applyDecision({status: 'SOMETHING_NEW' as 'SUCCESS'})).toEqual({apply: false})
  })

  it('skips a missing result rather than assuming success', () => {
    expect(applyDecision(null)).toEqual({apply: false})
    expect(applyDecision(undefined)).toEqual({apply: false})
  })

  it('treats absent segment detail on a partial success as no successful segments', () => {
    expect(applyDecision({status: 'PARTIAL_SUCCESS', segments: null})).toEqual({apply: true, segments: []})
  })
})
