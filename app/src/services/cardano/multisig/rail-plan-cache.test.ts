import {describe, expect, it} from 'vitest'
import {decodeRailPlan, encodeRailPlan, railPlanKey, type StoredRailPlan} from './rail-plan-cache'
import type {SharedRailPlan} from './rail-resolution'

const plan: SharedRailPlan = {
  keyIndex: 2,
  primaryAddress: 'addr1_shared_2',
  others: [{keyIndex: 0, addressBech32: 'addr1_shared_0'}],
  spansIndexes: true,
  truncated: false,
}

const stored: StoredRailPlan = {at: 1_700_000_000_000, plan}

describe('railPlanKey', () => {
  it('is per network and per wallet, so one roster plan is never served for another', () => {
    expect(railPlanKey(1, 'w1')).not.toBe(railPlanKey(0, 'w1'))
    expect(railPlanKey(1, 'w1')).not.toBe(railPlanKey(1, 'w2'))
  })
})

describe('decodeRailPlan', () => {
  it('round-trips a plan', () => {
    expect(decodeRailPlan(encodeRailPlan(stored))).toEqual(stored)
  })

  it('is null when nothing is stored', () => {
    expect(decodeRailPlan(null)).toBeNull()
    expect(decodeRailPlan('')).toBeNull()
  })

  it('is null for anything that is not JSON', () => {
    expect(decodeRailPlan('{oh no')).toBeNull()
  })

  it('discards an entry from a shape this build does not know', () => {
    expect(decodeRailPlan(JSON.stringify({version: 99, at: 1, plan}))).toBeNull()
  })

  it('refuses a plan with no spending index — that is what a spend signs against', () => {
    const {keyIndex: _dropped, ...withoutIndex} = plan
    expect(decodeRailPlan(JSON.stringify({version: 1, at: 1, plan: withoutIndex}))).toBeNull()
  })

  it('refuses a plan whose primary address is missing or empty', () => {
    expect(decodeRailPlan(JSON.stringify({version: 1, at: 1, plan: {...plan, primaryAddress: ''}}))).toBeNull()
    const {primaryAddress: _dropped, ...withoutAddress} = plan
    expect(decodeRailPlan(JSON.stringify({version: 1, at: 1, plan: withoutAddress}))).toBeNull()
  })

  it('refuses a plan whose other indexes are half-written', () => {
    const others = [{addressBech32: 'addr1_shared_0'}]
    expect(decodeRailPlan(JSON.stringify({version: 1, at: 1, plan: {...plan, others}}))).toBeNull()
  })

  it('keeps a truncated plan — it says so itself, and consumers read the flag', () => {
    const truncated = {...stored, plan: {...plan, truncated: true}}
    expect(decodeRailPlan(encodeRailPlan(truncated))?.plan.truncated).toBe(true)
  })
})
