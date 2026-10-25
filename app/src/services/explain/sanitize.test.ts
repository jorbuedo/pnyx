import {describe, expect, it} from 'vitest'
import {sanitizeExplanation} from './sanitize'

describe('sanitizeExplanation', () => {
  // Observed verbatim on a Pixel 10, with "Never copy a label such as SAFETY:" present
  // in the prompt. The rule was ignored, which is why this is code.
  it('strips the SAFETY label the model copied from the prompt', () => {
    const raw =
      'SAFETY: A signature in this transaction was made with a predictable nonce and therefore REVEALS ITS OWN SIGNING KEY.\n\nYou sent out a total of 4.838723 ADA.'
    const clean = sanitizeExplanation(raw)
    expect(clean).not.toContain('SAFETY:')
    expect(clean.startsWith('A signature in this transaction')).toBe(true)
    // The content itself must survive intact.
    expect(clean).toContain('REVEALS ITS OWN SIGNING KEY')
    expect(clean).toContain('You sent out a total of 4.838723 ADA.')
  })

  it('strips every label the prompt emits, wherever the line starts', () => {
    for (const label of [
      'SAFETY',
      'FACTS',
      'OTHER PARTIES',
      "THE OWNER'S OWN WALLET",
      'WHAT THE TRANSACTION DID',
      'WHAT APPROVING ACTUALLY DOES',
      'UNTRUSTED',
    ]) {
      expect(sanitizeExplanation(`${label}: something happened`)).toBe('something happened')
    }
  })

  it('is case-insensitive, since the model reformats what it copies', () => {
    expect(sanitizeExplanation('Safety: it leaked a key')).toBe('it leaked a key')
  })

  it('strips a label on a later line too', () => {
    expect(sanitizeExplanation('You sent 5 ADA.\nOTHER PARTIES: someone got 3 ADA.')).toBe(
      'You sent 5 ADA.\nsomeone got 3 ADA.',
    )
  })

  // Trimming on a guess would show the user something that was never said.
  it('leaves ordinary prose with a colon alone', () => {
    const text = 'You sent 5 ADA. The reason: the recipient asked for it.'
    expect(sanitizeExplanation(text)).toBe(text)
  })

  it('does not strip a word that merely starts like a label', () => {
    const text = 'Safeties were not checked here.'
    expect(sanitizeExplanation(text)).toBe(text)
  })

  it('collapses the blank line a stripped label leaves behind', () => {
    expect(sanitizeExplanation('SAFETY: a key leaked.\n\n\n\nYou sent 5 ADA.')).toBe('a key leaked.\n\nYou sent 5 ADA.')
  })

  it('trims surrounding whitespace', () => {
    expect(sanitizeExplanation('  \n You sent 5 ADA. \n ')).toBe('You sent 5 ADA.')
  })

  it('returns empty for empty input rather than throwing', () => {
    expect(sanitizeExplanation('')).toBe('')
  })
})
