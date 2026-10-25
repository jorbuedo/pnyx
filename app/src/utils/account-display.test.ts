import {describe, expect, it} from 'vitest'
import {accountDisplayName, accountIdenticonSeed} from './account-display'

describe('accountDisplayName', () => {
  it('returns the plain name for a single-account group', () => {
    expect(accountDisplayName('Rahul', 0, 1)).toBe('Rahul')
  })

  it('suffixes the 0-based account index once a group has more than one account', () => {
    expect(accountDisplayName('Rahul', 0, 2)).toBe('Rahul #0')
    expect(accountDisplayName('Rahul', 1, 2)).toBe('Rahul #1')
    expect(accountDisplayName('Rahul', 2, 3)).toBe('Rahul #2')
  })

  it('treats a zero/empty account count as single-account (no suffix)', () => {
    expect(accountDisplayName('Rahul', 0, 0)).toBe('Rahul')
  })
})

describe('accountIdenticonSeed', () => {
  it('keeps the base seed for account 0', () => {
    expect(accountIdenticonSeed('abc123', 0)).toBe('abc123')
  })

  it('appends the index for non-zero accounts so each icon is distinct + stable', () => {
    expect(accountIdenticonSeed('abc123', 1)).toBe('abc123#1')
    expect(accountIdenticonSeed('abc123', 2)).toBe('abc123#2')
    expect(accountIdenticonSeed('abc123', 1)).toBe(accountIdenticonSeed('abc123', 1))
  })
})
