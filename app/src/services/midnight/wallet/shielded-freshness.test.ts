import {describe, expect, it} from 'vitest'

import {BUILD_LAG_TOLERANCE_BLOCKS, freshnessAllowsBuild, shieldedFreshness} from './shielded-freshness'

describe('shieldedFreshness', () => {
  it('is never-synced when no cursor exists', () => {
    expect(shieldedFreshness({cursor: undefined, tip: 100})).toEqual({kind: 'never-synced'})
  })

  it('is current at the tip', () => {
    expect(shieldedFreshness({cursor: 100, tip: 100})).toEqual({kind: 'current', cursor: 100})
  })

  it('is current past the tip, which a rollback or an indexer switch produces', () => {
    expect(shieldedFreshness({cursor: 120, tip: 100}).kind).toBe('current')
  })

  it('is behind below the tip, and says by how much', () => {
    expect(shieldedFreshness({cursor: 40, tip: 10_000})).toEqual({kind: 'behind', cursor: 40, tip: 10_000})
  })

  it('is unknown when the tip could not be read, carrying why', () => {
    expect(shieldedFreshness({cursor: 40, tip: null, tipFailure: 'indexer responded 502'})).toEqual({
      kind: 'unknown',
      cursor: 40,
      reason: 'indexer responded 502',
    })
  })

  it('treats a cursor of 0 as a cursor, not as absence', () => {
    // A height of 0 never reaches the store (`parseStoredCursor` requires a positive integer), but the
    // rule must not depend on that: `cursor ?? …` and `cursor || …` differ here, and the second would
    // report a wallet that has scanned as one that never has.
    expect(shieldedFreshness({cursor: 0, tip: 10_000}).kind).toBe('behind')
  })
})

describe('freshnessAllowsBuild', () => {
  it('allows a current state', () => {
    expect(freshnessAllowsBuild({kind: 'current', cursor: 100})).toBe(true)
  })

  it('refuses a state that is behind', () => {
    // ⚠️ The whole point of the module. The native selector would otherwise answer "holds 0 of this
    // token" — a statement about the wallet, when the truth is a statement about the scan.
    expect(freshnessAllowsBuild({kind: 'behind', cursor: 40, tip: 100})).toBe(false)
  })

  it('refuses a state that has never synced', () => {
    expect(freshnessAllowsBuild({kind: 'never-synced'})).toBe(false)
  })

  it('allows a build when freshness could not be established', () => {
    // ⚠️ Deliberate asymmetry: the coins in hand were applied from confirmed blocks and their tree root
    // was checked against the chain, so they are spendable whatever the indexer is doing. Refusing would
    // turn an indexer hiccup into a wallet that cannot spend money it provably holds.
    expect(freshnessAllowsBuild({kind: 'unknown', cursor: 40, reason: 'timeout'})).toBe(true)
  })
})

describe('the lag tolerance', () => {
  it('counts a wallet a few blocks behind as current', () => {
    // ⚠️ Measured on preprod: a walk that reached the tip was one block behind by the time the user
    // reached the review, and an exact `cursor >= tip` refused a wallet holding the coin — twice.
    expect(shieldedFreshness({cursor: 2_545_397, tip: 2_545_398}).kind).toBe('current')
    expect(shieldedFreshness({cursor: 100 - BUILD_LAG_TOLERANCE_BLOCKS, tip: 100}).kind).toBe('current')
  })

  it('still refuses a wallet that is genuinely behind', () => {
    expect(shieldedFreshness({cursor: 100 - BUILD_LAG_TOLERANCE_BLOCKS - 1, tip: 100}).kind).toBe('behind')
    expect(shieldedFreshness({cursor: 2_483_079, tip: 2_545_398}).kind).toBe('behind')
  })
})
