import {TEST_MNEMONIC, WalletSeeds} from '@midnight-ntwrk/testkit-js'
import {describe, expect, it} from 'vitest'
import {masterSeedFrom} from './master-seed.js'

const ok = (input: string) => {
  const result = masterSeedFrom(input)
  if (!result.ok) throw new Error(`expected a seed, got: ${result.reason}`)
  return result
}

const refusal = (input: string) => {
  const result = masterSeedFrom(input)
  if (result.ok) throw new Error(`expected a refusal, got a ${result.format} seed`)
  return result
}

describe('masterSeedFrom', () => {
  it('derives the same master seed the wallet SDK derives from a mnemonic', () => {
    // The pin that matters: this is the wallet the app opens from the same phrase.
    expect(ok(TEST_MNEMONIC).masterSeed).toBe(WalletSeeds.fromMnemonic(TEST_MNEMONIC).masterSeed)
  })

  it('reports a mnemonic as such, with its word count', () => {
    expect(ok(TEST_MNEMONIC)).toMatchObject({format: 'mnemonic', summary: '24-word mnemonic'})
  })

  it('derives a 64-byte seed from a mnemonic', () => {
    expect(ok(TEST_MNEMONIC).masterSeed).toHaveLength(128)
  })

  it('reads a phrase the same whatever whitespace surrounds or separates it', () => {
    const canonical = ok(TEST_MNEMONIC).masterSeed
    expect(ok(`\n  ${TEST_MNEMONIC}\n`).masterSeed).toBe(canonical)
    expect(ok(TEST_MNEMONIC.replace(/ /g, '  ')).masterSeed).toBe(canonical)
    expect(ok(TEST_MNEMONIC.replace(/ /g, '\n')).masterSeed).toBe(canonical)
  })

  it('passes a 32-byte hex seed through, lowercased', () => {
    const hex = 'AB'.repeat(32)
    expect(ok(hex)).toMatchObject({masterSeed: 'ab'.repeat(32), format: 'hex', summary: '32-byte hex seed'})
  })

  it('passes a 64-byte hex seed through', () => {
    const hex = 'cd'.repeat(64)
    expect(ok(hex)).toMatchObject({masterSeed: hex, format: 'hex', summary: '64-byte hex seed'})
  })

  it('refuses a mnemonic whose checksum does not hold', () => {
    // One word changed — the shape of a typo, and what mnemonicToSeedSync would happily derive an
    // empty wallet from.
    const typo = TEST_MNEMONIC.replace(/^abandon/, 'ability')
    expect(refusal(typo).reason).toContain('24 words')
  })

  it('refuses a phrase of the wrong length', () => {
    expect(refusal('abandon abandon abandon').reason).toContain('3 words')
  })

  it('refuses hex of a length no seed has', () => {
    expect(refusal('ab'.repeat(20)).reason).toContain('40 characters')
  })

  it('refuses an empty or whitespace-only input', () => {
    expect(refusal('').reason).toContain('empty')
    expect(refusal('   \n ').reason).toContain('empty')
  })

  it('never puts the input in the refusal reason', () => {
    const secret = TEST_MNEMONIC.replace(/^abandon/, 'ability')
    const {reason} = refusal(secret)
    for (const word of new Set(secret.split(' '))) expect(reason).not.toContain(word)
    expect(refusal('ab'.repeat(20)).reason).not.toContain('ab'.repeat(20))
  })
})
