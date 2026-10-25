import {describe, expect, it} from 'vitest'

import {expectedFor} from './expected-warnings'

describe('expectedFor', () => {
  it('expects the mint a registration is', () => {
    expect(expectedFor('register')).toContain('minting')
    expect(expectedFor('register')).not.toContain('burning')
  })

  it('expects the burn a deregistration is', () => {
    expect(expectedFor('deregister')).toContain('burning')
    expect(expectedFor('deregister')).not.toContain('minting')
  })

  // The defect this pins: `changeDestination` became two legs — a deregister that burns the auth token
  // and a register that mints the new one — while this table still described the single spend-and-
  // recreate transaction the validator turned out not to have. One set covers every leg, so both legs
  // of the operation the user explicitly asked for were about to be flagged as unexpected.
  it('expects BOTH the burn and the mint a destination change is made of', () => {
    expect(expectedFor('changeDestination')).toEqual(
      expect.arrayContaining(['plutus-contract', 'large-fee', 'unresolved-inputs', 'burning', 'minting']),
    )
  })

  it('never expects a warning that is not definitional for the operation', () => {
    for (const kind of ['register', 'deregister', 'changeDestination'] as const) {
      expect(expectedFor(kind)).not.toContain('stake-credential-reuse')
      expect(expectedFor(kind)).not.toContain('multi-sig')
    }
  })
})
