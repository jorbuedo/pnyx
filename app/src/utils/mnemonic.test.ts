import {describe, expect, it} from 'vitest'
import {getBip39Suggestions, getMnemonicTypoError, isValidBip39Word, validateMnemonicChecksum} from './mnemonic'

// Canonical BIP-39 zero-entropy phrases — every word is `abandon` plus the
// final checksum word, which is the alphabetically-lowest wordlist entry
// that satisfies the checksum for that entropy length. These are the
// simplest valid mnemonics for 12/15/24-word phrases and roundtrip cleanly
// through the wallet crypto layer's `Mnemonic` constructor.
const VALID_12_WORDS = [
  'abandon',
  'abandon',
  'abandon',
  'abandon',
  'abandon',
  'abandon',
  'abandon',
  'abandon',
  'abandon',
  'abandon',
  'abandon',
  'about',
] as const
const VALID_15_WORDS = [
  'abandon',
  'abandon',
  'abandon',
  'abandon',
  'abandon',
  'abandon',
  'abandon',
  'abandon',
  'abandon',
  'abandon',
  'abandon',
  'abandon',
  'abandon',
  'abandon',
  'address',
] as const
const VALID_24_WORDS = [
  'abandon',
  'abandon',
  'abandon',
  'abandon',
  'abandon',
  'abandon',
  'abandon',
  'abandon',
  'abandon',
  'abandon',
  'abandon',
  'abandon',
  'abandon',
  'abandon',
  'abandon',
  'abandon',
  'abandon',
  'abandon',
  'abandon',
  'abandon',
  'abandon',
  'abandon',
  'abandon',
  'art',
] as const

describe('getMnemonicTypoError', () => {
  it('returns null for empty input', () => {
    expect(getMnemonicTypoError('')).toBeNull()
  })

  it('returns null while the partial last word is being typed (no space)', () => {
    // "abou" is not a BIP-39 word, but it has no trailing space → not committed → no error.
    expect(getMnemonicTypoError('abandon abandon abou')).toBeNull()
  })

  it('returns null when the partial last word is the only token', () => {
    expect(getMnemonicTypoError('abou')).toBeNull()
  })

  it('returns invalidWords as soon as a typo is followed by a space', () => {
    expect(getMnemonicTypoError('abandon notaword ')).toBe('invalidWords')
  })

  it('returns invalidWords on paste with a typo (trailing space added by hook)', () => {
    const phrase = `${'abandon '.repeat(11)}notaword `
    expect(getMnemonicTypoError(phrase)).toBe('invalidWords')
  })

  it('flags a partial last word that cannot become a BIP-39 word (no prefix match)', () => {
    expect(getMnemonicTypoError('abandon blahx')).toBe('invalidWords')
  })

  it('does not flag a partial last word that still has BIP-39 prefix matches', () => {
    expect(getMnemonicTypoError('abandon abou')).toBeNull()
  })

  it('does not flag a partial single-character last word even if no completion', () => {
    // Don't fire on single char; many letters happen to have no immediate prefix
    // matches mid-keystroke and the noise would be too aggressive.
    expect(getMnemonicTypoError('x')).toBeNull()
  })

  it('flags pasted phrase ending in a definitely-typo last word with no trailing space', () => {
    const phrase = `${'abandon '.repeat(11)}blahx`
    expect(getMnemonicTypoError(phrase)).toBe('invalidWords')
  })

  it('returns null for all valid committed words even at intermediate counts', () => {
    expect(getMnemonicTypoError('abandon abandon abandon ')).toBeNull()
  })

  it('returns null for a fully committed valid 12-word phrase', () => {
    const phrase = `${'abandon '.repeat(11)}about `
    expect(getMnemonicTypoError(phrase)).toBeNull()
  })
})

// `isValidBip39Word` and `getBip39Suggestions` are also covered indirectly by
// the `getMnemonicTypoError` and `validateMnemonicChecksum` suites, but a
// couple of focused cases pin down the contract directly so a future refactor
// of the wordlist plumbing (Set/Array split, normalization) doesn't silently
// drift.
describe('isValidBip39Word', () => {
  it('accepts a known wordlist entry regardless of casing or whitespace', () => {
    expect(isValidBip39Word('abandon')).toBe(true)
    expect(isValidBip39Word('  Abandon  ')).toBe(true)
    expect(isValidBip39Word('ABOUT')).toBe(true)
  })

  it('rejects words not in the wordlist', () => {
    expect(isValidBip39Word('notaword')).toBe(false)
    expect(isValidBip39Word('')).toBe(false)
  })
})

describe('getBip39Suggestions', () => {
  it('returns nothing for inputs shorter than 2 chars', () => {
    expect(getBip39Suggestions('')).toEqual([])
    expect(getBip39Suggestions('a')).toEqual([])
  })

  it('returns prefix matches in alphabetical order', () => {
    const matches = getBip39Suggestions('aban', 5)
    // The wordlist contains "abandon" near the top of the `ab*` block; we just
    // assert that the results all share the prefix and include `abandon`.
    expect(matches.length).toBeGreaterThan(0)
    expect(matches).toContain('abandon')
    for (const word of matches) {
      expect(word.startsWith('aban')).toBe(true)
    }
  })

  it('caps the result list at maxResults', () => {
    expect(getBip39Suggestions('a', 3).length).toBeLessThanOrEqual(3)
    expect(getBip39Suggestions('ab', 2).length).toBeLessThanOrEqual(2)
  })

  it('returns an empty array when nothing matches', () => {
    expect(getBip39Suggestions('zzz')).toEqual([])
  })
})

describe('validateMnemonicChecksum', () => {
  it('accepts the canonical 12-word zero-entropy phrase', () => {
    expect(validateMnemonicChecksum(VALID_12_WORDS)).toBe(true)
  })

  it('accepts the canonical 15-word zero-entropy phrase', () => {
    expect(validateMnemonicChecksum(VALID_15_WORDS)).toBe(true)
  })

  it('accepts the canonical 24-word zero-entropy phrase', () => {
    expect(validateMnemonicChecksum(VALID_24_WORDS)).toBe(true)
  })

  it('rejects an empty array (word count not 12/15/24)', () => {
    expect(validateMnemonicChecksum([])).toBe(false)
  })

  it('rejects a phrase with the wrong word count', () => {
    // 11 words — close to a valid length but not in VALID_MNEMONIC_WORD_COUNTS.
    expect(validateMnemonicChecksum(VALID_12_WORDS.slice(0, 11))).toBe(false)
    // 13 words — pad a valid 12 with one extra
    expect(validateMnemonicChecksum([...VALID_12_WORDS, 'abandon'])).toBe(false)
  })

  it('rejects a phrase containing a non-BIP-39 word', () => {
    const phrase = [...VALID_12_WORDS.slice(0, 11), 'notaword']
    expect(validateMnemonicChecksum(phrase)).toBe(false)
  })

  it('rejects a phrase with valid words but a wrong checksum', () => {
    // 12 valid wordlist entries, but the resulting checksum doesn't match —
    // this is the "right words, wrong order" / "tampered phrase" case
    // surfaces with a distinct error message.
    const phrase = [
      'abandon',
      'about',
      'abandon',
      'abandon',
      'abandon',
      'abandon',
      'abandon',
      'abandon',
      'abandon',
      'abandon',
      'abandon',
      'abandon',
    ]
    expect(validateMnemonicChecksum(phrase)).toBe(false)
  })
})
