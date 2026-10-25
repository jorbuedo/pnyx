/**
 * Mnemonic utility functions.
 *
 * Shared BIP-39 mnemonic validation and word suggestion utilities
 * used across restore wallet and mnemonic input components.
 *
 * @module
 */

import {validateMnemonic as bip39ValidateMnemonic} from '@scure/bip39'
import {wordlist} from '@scure/bip39/wordlists/english.js'

/** Valid word counts for BIP39 mnemonics supported by the app */
export const VALID_MNEMONIC_WORD_COUNTS = [12, 15, 24] as const

/** Type for valid mnemonic word counts */
export type MnemonicWordCount = (typeof VALID_MNEMONIC_WORD_COUNTS)[number]

/**
 * Normalize text for wordlist matching.
 */
const normalizeWord = (text: string): string => text.toLowerCase().trim()

/**
 * The English BIP-39 wordlist is 2048 alphabetically-sorted words. Holding
 * both an array (for ordered prefix scans) and a Set (for O(1) membership)
 * lets the hot-paths used by the recovery-phrase flow run in constant time
 * on every keystroke.
 */
const wordlistArray = wordlist as readonly string[]
const wordlistSet = new Set(wordlistArray)

/**
 * Check if a word is in the BIP39 wordlist.
 */
export const isValidBip39Word = (word: string): boolean => {
  return wordlistSet.has(normalizeWord(word))
}

/**
 * Get word suggestions from the BIP39 wordlist.
 *
 * Walks the alphabetically-sorted wordlist forward and stops as soon as we
 * pass the contiguous range of words starting with `input` — so for prefixes
 * with no matches we typically exit far before scanning the full 2048 words.
 */
export const getBip39Suggestions = (input: string, maxResults = 5): string[] => {
  if (!input || input.length < 2) return []
  const normalized = normalizeWord(input)
  const results: string[] = []
  for (const word of wordlistArray) {
    if (word.startsWith(normalized)) {
      results.push(word)
      if (results.length === maxResults) return results
    } else if (word > normalized) {
      return results
    }
  }
  return results
}

/**
 * Normalize and parse mnemonic text into words.
 */
export const parseMnemonicWords = (text: string): string[] => {
  return text
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0)
}

/**
 * Get the current word being typed (last word if text doesn't end with space).
 */
export const getCurrentTypingWord = (text: string): string => {
  if (text.endsWith(' ') || text.length === 0) return ''
  const words = text.split(/\s+/)
  return words[words.length - 1]?.toLowerCase() ?? ''
}

/** Live validation error types surfaced while the user is typing. */
export type MnemonicValidationError = 'invalidWords' | null

/**
 * Return `'invalidWords'` if any committed word in the input is not a BIP-39 word.
 *
 * A word is "committed" when:
 * - it is followed by a space (paste/autocomplete appends one), OR
 * - the user is on the last word and what they typed cannot become a BIP-39 word
 *   (no prefix completion exists), so there's no point waiting for them to finish.
 *
 * The currently-typed last word is otherwise excluded so we don't flash an error
 * while the user is still composing.
 *
 * Originally landed for the bug "No error messages while entering wrong seed
 * phrase during onboarding"). Used by the legacy textarea-based flow via
 * `useMnemonicInput`. The redesign-v2 word-grid flow does its own per-cell
 * check using `isValidBip39Word` directly — different UX, same underlying
 * wordlist.
 */
export const getMnemonicTypoError = (text: string): MnemonicValidationError => {
  const words = parseMnemonicWords(text)
  if (words.length === 0) return null

  const lastWord = words[words.length - 1] ?? ''
  const lastWordTrailedBySpace = text.endsWith(' ')
  const lastWordIsDefinitelyTypo =
    lastWord.length >= 2 && !isValidBip39Word(lastWord) && getBip39Suggestions(lastWord, 1).length === 0
  const lastWordCommitted = lastWordTrailedBySpace || lastWordIsDefinitelyTypo

  const committed = lastWordCommitted ? words : words.slice(0, -1)
  return committed.some((w) => !isValidBip39Word(w)) ? 'invalidWords' : null
}

/**
 * Validate a mnemonic phrase.
 *
 * Checks:
 * - Word count is valid (12, 15, or 24)
 * - All words are in the BIP39 wordlist
 * - Checksum is valid (via @scure/bip39)
 */
export const validateMnemonic = (text: string): {isValid: boolean; wordCount: number; allWordsValid: boolean} => {
  const words = parseMnemonicWords(text)
  const wordCount = words.length
  const allWordsValid = words.every(isValidBip39Word)

  if (!VALID_MNEMONIC_WORD_COUNTS.includes(wordCount as MnemonicWordCount) || !allWordsValid) {
    return {isValid: false, wordCount, allWordsValid}
  }

  const isValid = bip39ValidateMnemonic(words.join(' '), wordlist)
  return {isValid, wordCount, allWordsValid}
}

/**
 * Validate ONLY the BIP-39 checksum of a normalized phrase.
 *
 * Use this AFTER you've already validated word count + per-word membership
 * via per-cell `isValidBip39Word` checks. Separating the checksum check from
 * `validateMnemonic` lets the redesign-v2 word-grid surface a different error
 * message for "phrase has typos" vs "phrase is well-formed but checksum is
 * wrong (typically the words are in the wrong order)".
 */
export const validateMnemonicChecksum = (words: readonly string[]): boolean => {
  if (!VALID_MNEMONIC_WORD_COUNTS.includes(words.length as MnemonicWordCount)) return false
  if (!words.every(isValidBip39Word)) return false
  return bip39ValidateMnemonic(words.join(' '), wordlist)
}
