import {describe, expect, it} from 'vitest'
import {actionRegisters, decideDelegation, type StakeAccountState, stakeStateFromAccountInfo} from './state'

const POOL_A = 'pool1dghwejqptsjtf9k8paspg9rhl8humxx0nh7sk37j0ada2dr9mqh'
const POOL_B = 'pool1z5uqdk7dzdxaae5633fqfcu2eqzy3a3rgtuvy087fdld7yws0xt'

const FRESH: StakeAccountState = {
  registered: false,
  currentPool: null,
  currentDrep: null,
  rewardsAvailable: 0n,
  deposit: null,
}

const DELEGATED: StakeAccountState = {
  registered: true,
  currentPool: POOL_A,
  currentDrep: {kind: 'abstain'},
  rewardsAvailable: 0n,
  deposit: 2_000_000n,
}

describe('stakeStateFromAccountInfo', () => {
  it('null (never-seen account) is the unregistered empty state', () => {
    expect(stakeStateFromAccountInfo(null)).toEqual(FRESH)
  })

  // ⚠️ The fields are Evolution's: `delegatedDRep`, and `undefined` for a deposit the backend did
  // not report — the same fact this screen stores as `null`, converted at the mapper.
  it('lowercases the pool id and canonicalizes the DRep literal', () => {
    const state = stakeStateFromAccountInfo({
      registered: true,
      delegatedPool: POOL_A.toUpperCase(),
      delegatedDRep: 'drep_always_no_confidence',
      rewardsAvailable: 5n,
      deposit: undefined,
      controlledBalance: undefined,
    })
    expect(state.currentPool).toBe(POOL_A)
    expect(state.currentDrep).toEqual({kind: 'no_confidence'})
  })

  it('an unparseable DRep value degrades to null, never a guessed target', () => {
    const state = stakeStateFromAccountInfo({
      registered: true,
      delegatedPool: null,
      delegatedDRep: 'garbage-value',
      rewardsAvailable: 0n,
      deposit: undefined,
      controlledBalance: undefined,
    })
    expect(state.currentDrep).toBeNull()
  })
})

describe('decideDelegation', () => {
  it('unregistered: pool+drep → combined reg cert; deposit applies', () => {
    const action = decideDelegation(FRESH, {pool: POOL_A, drep: {kind: 'abstain'}})
    expect(action).toEqual({kind: 'stake-vote-reg', poolId: POOL_A, drep: {kind: 'abstain'}})
    expect(actionRegisters(action)).toBe(true)
  })

  it('unregistered single-target variants register too', () => {
    expect(decideDelegation(FRESH, {pool: POOL_A, drep: null})).toEqual({kind: 'stake-reg', poolId: POOL_A})
    expect(decideDelegation(FRESH, {pool: null, drep: {kind: 'no_confidence'}})).toEqual({
      kind: 'vote-reg',
      drep: {kind: 'no_confidence'},
    })
  })

  it('registered: only what changed is certified', () => {
    expect(decideDelegation(DELEGATED, {pool: POOL_B, drep: {kind: 'abstain'}})).toEqual({
      kind: 'stake',
      poolId: POOL_B,
    })
    expect(decideDelegation(DELEGATED, {pool: POOL_A, drep: {kind: 'no_confidence'}})).toEqual({
      kind: 'vote',
      drep: {kind: 'no_confidence'},
    })
    expect(decideDelegation(DELEGATED, {pool: POOL_B, drep: {kind: 'no_confidence'}})).toEqual({
      kind: 'stake-vote',
      poolId: POOL_B,
      drep: {kind: 'no_confidence'},
    })
    expect(actionRegisters(decideDelegation(DELEGATED, {pool: POOL_B, drep: null}))).toBe(false)
  })

  it('pool comparison is case-insensitive; unchanged selection is a noop', () => {
    expect(decideDelegation(DELEGATED, {pool: POOL_A.toUpperCase(), drep: {kind: 'abstain'}})).toEqual({kind: 'noop'})
    expect(decideDelegation(DELEGATED, {pool: null, drep: null})).toEqual({kind: 'noop'})
  })
})
