/**
 * Mnemonic-verification fixtures for the UI Playground.
 *
 * Real BIP-39 words so the cells validate the way they would in onboarding, but
 * an arbitrary sequence — this is not a usable phrase.
 *
 * @module
 */

import type {WordEntry} from '../../components/MnemonicVerification'

const WORDS = [
  'abandon',
  'ability',
  'able',
  'about',
  'above',
  'absent',
  'absorb',
  'abstract',
  'absurd',
  'abuse',
  'access',
  'accident',
] as const

export const fakeWordEntries: WordEntry[] = WORDS.map((word, id) => ({id, word}))
