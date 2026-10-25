import {describe, expect, it} from 'vitest'

import {syncKeyAtCreate} from './sync-key-at-create'

describe('syncKeyAtCreate', () => {
  it('registers once the group has a Midnight chain and a funds network', () => {
    expect(syncKeyAtCreate({hasMidnight: true, fundsNetwork: 'mainnet'})).toEqual({remember: true})
  })

  // The defect this closes. `preparing` builds the group one chain at a time, so the Cardano leg
  // sees no Midnight chain — and the registration used to sit inside the enclave-write guard, which
  // runs only on that first leg. The leg that could remember the key was always the one that
  // skipped the block, so a new wallet kept no DUST current until a manual refresh.
  it('does not register on a leg that has not reached Midnight yet', () => {
    expect(syncKeyAtCreate({hasMidnight: false, fundsNetwork: 'mainnet'})).toEqual({
      remember: false,
      reason: 'awaiting-midnight-leg',
    })
  })

  // ⚠️ And it must be told apart from a real absence: this is a half-built group, not a wallet that
  // can hold no DUST. Reporting it as the latter is what put an `error` in every creation.
  it('names the wait rather than a missing chain', () => {
    const decision = syncKeyAtCreate({hasMidnight: false, fundsNetwork: 'mainnet'})
    expect(decision.remember).toBe(false)
    if (!decision.remember) expect(decision.reason).not.toBe('no-funds-network')
  })

  it('holds off when Midnight is present but no funds network is configured', () => {
    expect(syncKeyAtCreate({hasMidnight: true, fundsNetwork: null})).toEqual({
      remember: false,
      reason: 'no-funds-network',
    })
  })

  // The absent chain is reported ahead of the absent network: on the Cardano leg both are unknown,
  // and blaming the network would send a reader looking at config for a sequencing fact.
  it('reports the missing chain before the missing network', () => {
    expect(syncKeyAtCreate({hasMidnight: false, fundsNetwork: null})).toEqual({
      remember: false,
      reason: 'awaiting-midnight-leg',
    })
  })
})
