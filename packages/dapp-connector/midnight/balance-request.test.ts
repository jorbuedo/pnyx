import {describe, expect, it} from 'vitest'

import {readBalanceRequest} from './balance-request'

describe('readBalanceRequest', () => {
  const tx = 'deadBEEF'

  it('lowercases the hex so the host can compare bytes it built', () => {
    // `submitTransaction` recognises our own bytes by string identity, so one canonical case matters.
    expect(readBalanceRequest([tx])).toEqual({ok: true, request: {txHex: 'deadbeef', payFees: true}})
  })

  it('accepts an absent options object', () => {
    expect(readBalanceRequest([tx, undefined])).toMatchObject({ok: true})
  })

  it('accepts payFees: true, which is the only thing this wallet can do', () => {
    expect(readBalanceRequest([tx, {payFees: true}])).toMatchObject({ok: true})
  })

  it('carries payFees through rather than judging it', () => {
    // The device can pay its own way now; whether it can *right now* needs a synced DUST state, which
    // this module cannot see. The host answers instead.
    const read = readBalanceRequest([tx, {payFees: false}])
    expect(read.ok).toBe(true)
    if (read.ok) expect(read.request.payFees).toBe(false)
  })

  it('defaults payFees to true, as the API specifies', () => {
    const read = readBalanceRequest([tx])
    expect(read.ok).toBe(true)
    if (read.ok) expect(read.request.payFees).toBe(true)
  })

  it('refuses a payFees that is not a boolean', () => {
    const read = readBalanceRequest([tx, {payFees: 'yes'}])
    expect(read.ok).toBe(false)
    if (!read.ok) expect(read.error.message).toMatch(/payFees must be a boolean, not 'yes'/)
  })

  it('refuses a missing transaction', () => {
    expect(readBalanceRequest([]).ok).toBe(false)
  })

  it('refuses an empty transaction', () => {
    expect(readBalanceRequest(['']).ok).toBe(false)
  })

  it('refuses odd-length hex, which cannot be bytes', () => {
    expect(readBalanceRequest(['abc']).ok).toBe(false)
  })

  it('refuses non-hex characters', () => {
    expect(readBalanceRequest(['zzzz']).ok).toBe(false)
  })

  it('refuses a transaction that is not a string', () => {
    expect(readBalanceRequest([{tx: 'deadbeef'}]).ok).toBe(false)
  })

  it('refuses params that are not an array', () => {
    expect(readBalanceRequest('deadbeef').ok).toBe(false)
  })
})
