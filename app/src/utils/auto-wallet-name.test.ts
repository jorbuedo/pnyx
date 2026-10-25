import {describe, expect, it} from 'vitest'

import {dedupeWalletName, generateAutoWalletName, MAX_WALLET_NAME_LENGTH} from './auto-wallet-name'

describe('generateAutoWalletName', () => {
  // Names a funds-wallet group, never the identity — the identity is chosen by avatar and is not
  // named at all, so an "My Pnyx N" default made naming a wallet look like naming the account.
  it('returns "My Wallet" for the first wallet', () => {
    expect(generateAutoWalletName([])).toBe('My Wallet')
  })

  it('appends a number starting from the count + 1', () => {
    expect(generateAutoWalletName(['My Wallet'])).toBe('My Wallet 2')
  })

  it('skips names that already exist', () => {
    expect(generateAutoWalletName(['My Wallet', 'My Wallet 2'])).toBe('My Wallet 3')
  })

  it('names nothing after the product, so it cannot read as the account', () => {
    expect(generateAutoWalletName([])).not.toContain('Pnyx')
  })
})

describe('dedupeWalletName', () => {
  it('returns the proposed name when no conflict exists', () => {
    expect(dedupeWalletName('My Wallet', ['Other Wallet'])).toBe('My Wallet')
  })

  it('appends " (2)" on first collision', () => {
    expect(dedupeWalletName('My Wallet', ['My Wallet'])).toBe('My Wallet (2)')
  })

  it('increments suffix until unique', () => {
    expect(dedupeWalletName('W', ['W', 'W (2)', 'W (3)'])).toBe('W (4)')
  })

  it('truncates a name longer than MAX_WALLET_NAME_LENGTH', () => {
    const long = 'A'.repeat(50)
    const result = dedupeWalletName(long, [])
    expect(result).toBe('A'.repeat(MAX_WALLET_NAME_LENGTH))
    expect(result.length).toBe(MAX_WALLET_NAME_LENGTH)
  })

  it('dedupes against the truncated name, not the original', () => {
    const long = 'A'.repeat(50)
    const truncated = 'A'.repeat(MAX_WALLET_NAME_LENGTH)
    // The truncated form already exists — must not return a duplicate.
    const result = dedupeWalletName(long, [truncated])
    expect(result).toBe(`${'A'.repeat(MAX_WALLET_NAME_LENGTH - 4)} (2)`)
    expect(result.length).toBe(MAX_WALLET_NAME_LENGTH)
  })

  it('keeps result within MAX_WALLET_NAME_LENGTH when suffix is added to a 40-char name', () => {
    const exactly40 = 'B'.repeat(MAX_WALLET_NAME_LENGTH)
    const result = dedupeWalletName(exactly40, [exactly40])
    expect(result.length).toBeLessThanOrEqual(MAX_WALLET_NAME_LENGTH)
    expect(result).toBe(`${'B'.repeat(MAX_WALLET_NAME_LENGTH - 4)} (2)`)
  })

  it('handles n=9 to n=10 rollover where suffix grows by one char', () => {
    const base = 'C'.repeat(MAX_WALLET_NAME_LENGTH)
    const existing = [
      base,
      ...Array.from({length: 9}, (_, i) => {
        const suffix = ` (${i + 2})`
        return `${'C'.repeat(MAX_WALLET_NAME_LENGTH - suffix.length)}${suffix}`
      }),
    ]
    const result = dedupeWalletName(base, existing)
    // " (11)" is 5 chars, so base is truncated to 35
    expect(result).toBe(`${'C'.repeat(MAX_WALLET_NAME_LENGTH - 5)} (11)`)
    expect(result.length).toBe(MAX_WALLET_NAME_LENGTH)
  })

  it('never exceeds MAX_WALLET_NAME_LENGTH regardless of suffix size', () => {
    const base = 'D'.repeat(MAX_WALLET_NAME_LENGTH)
    const existing = [
      base,
      ...Array.from({length: 98}, (_, i) => {
        const suffix = ` (${i + 2})`
        return `${'D'.repeat(MAX_WALLET_NAME_LENGTH - suffix.length)}${suffix}`
      }),
    ]
    const result = dedupeWalletName(base, existing)
    expect(result.length).toBeLessThanOrEqual(MAX_WALLET_NAME_LENGTH)
    expect(result).toContain(' (100)')
  })
})
