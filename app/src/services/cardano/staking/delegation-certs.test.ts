import {describe, expect, it} from 'vitest'

import {parseDRepTarget} from '../../cardano-pool-drep/drep-id'
import {combinedCertsAllowed, delegationCertSteps} from './delegation-certs'
import type {DelegationAction} from './state'

const POOL = 'pool1z5uqdk7dzdxaae5633fqfcu2eqzy3a3rgtuvy087fdld7yws0xt'
const DREP = parseDRepTarget('drep_always_abstain')
if (DREP === null) throw new Error('fixture drep must parse')

const kinds = (action: DelegationAction, signer: Parameters<typeof delegationCertSteps>[1]): readonly string[] =>
  delegationCertSteps(action, signer).map((s) => s.kind)

describe('combinedCertsAllowed', () => {
  it('allows the combined certificates for a software wallet only', () => {
    expect(combinedCertsAllowed('software')).toBe(true)
    expect(combinedCertsAllowed('hardware')).toBe(false)
    expect(combinedCertsAllowed('script')).toBe(false)
    // An unknown signer gets the answer that cannot be wrong.
    expect(combinedCertsAllowed(null)).toBe(false)
  })
})

describe('delegationCertSteps', () => {
  const actions: ReadonlyArray<readonly [DelegationAction, readonly string[], readonly string[]]> = [
    [
      {kind: 'stake-vote-reg', poolId: POOL, drep: DREP},
      ['register-delegate-stake-vote'],
      ['register', 'delegate-stake', 'delegate-vote'],
    ],
    [{kind: 'stake-reg', poolId: POOL}, ['register-delegate-stake'], ['register', 'delegate-stake']],
    [{kind: 'vote-reg', drep: DREP}, ['register-delegate-vote'], ['register', 'delegate-vote']],
    [{kind: 'stake-vote', poolId: POOL, drep: DREP}, ['delegate-stake-vote'], ['delegate-stake', 'delegate-vote']],
    // These two have no combined form to lose: one certificate either way.
    [{kind: 'stake', poolId: POOL}, ['delegate-stake'], ['delegate-stake']],
    [{kind: 'vote', drep: DREP}, ['delegate-vote'], ['delegate-vote']],
    [{kind: 'noop'}, [], []],
  ]

  for (const [action, software, device] of actions) {
    it(`${action.kind}: ${software.length} cert(s) for software, ${device.length} for a device`, () => {
      expect(kinds(action, 'software')).toEqual(software)
      expect(kinds(action, 'hardware')).toEqual(device)
      expect(kinds(action, 'script')).toEqual(device)
      expect(kinds(action, null)).toEqual(device)
    })
  }

  it('puts the registration first, because certificates apply in sequence', () => {
    // A delegation certificate ahead of the registration it depends on is rejected by the ledger,
    // so this ordering is the rule and not a presentation choice.
    for (const action of [
      {kind: 'stake-vote-reg', poolId: POOL, drep: DREP},
      {kind: 'stake-reg', poolId: POOL},
      {kind: 'vote-reg', drep: DREP},
    ] as const) {
      expect(kinds(action, 'hardware')[0]).toBe('register')
    }
  })

  it('carries the pool and drep into the decomposed steps', () => {
    // The combined certificate held both; three certificates must not lose either.
    const steps = delegationCertSteps({kind: 'stake-vote-reg', poolId: POOL, drep: DREP}, 'hardware')
    expect(steps).toEqual([
      {kind: 'register'},
      {kind: 'delegate-stake', poolId: POOL},
      {kind: 'delegate-vote', drep: DREP},
    ])
  })
})
