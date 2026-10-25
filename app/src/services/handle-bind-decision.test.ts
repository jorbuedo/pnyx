import {describe, expect, it} from 'vitest'
import {bindStep} from './handle-bind-decision'

describe('bindStep', () => {
  it('binds an unowned shell', () => {
    expect(bindStep('unbound')).toEqual({kind: 'bind'})
  })

  // ⚠️ The whole reason this decision exists. `bind` asserts an unowned shell, so a claim that treated
  // "mine" like any other owner told the owner their own name was taken — and a claim whose `bind`
  // landed and whose `setPrimaryName` did not could never be finished. It must not re-bind either: the
  // proof would fail and the retry would cost another permit.
  it('skips straight to displaying a name this identity already holds', () => {
    expect(bindStep('mine')).toEqual({kind: 'already-bound'})
  })

  it('refuses somebody else’s name as taken', () => {
    expect(bindStep('someone-else')).toEqual({kind: 'refuse', reason: 'taken'})
  })

  // Not `taken`: that invites a retry, and neither of these can ever succeed.
  it.each(['banned', 'burned'] as const)('refuses a %s name as reserved', (held) => {
    expect(bindStep(held)).toEqual({kind: 'refuse', reason: 'reserved'})
  })
})
