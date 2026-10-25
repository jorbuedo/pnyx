import {encodePnyxId} from '@pnyx/contract-client/identity'
import {describe, expect, it} from 'vitest'
import {authorHandle, authorLabel, disclosedAuthors} from './author-label'

const id = (fill: number): string => encodePnyxId(new Uint8Array(32).fill(fill))

const ALICE = id(0x11)
const BOB = id(0x22)

describe('disclosedAuthors', () => {
  it('keeps disclosed ids and drops pseudonyms', () => {
    expect(disclosedAuthors([ALICE, 'night-owl', BOB])).toEqual([ALICE, BOB])
  })

  it('deduplicates, so a chatty author is looked up once', () => {
    expect(disclosedAuthors([ALICE, ALICE, ALICE])).toEqual([ALICE])
  })

  it('is empty for a transcript of pseudonyms', () => {
    expect(disclosedAuthors(['lyra', 'castor', ''])).toEqual([])
  })
})

describe('authorHandle', () => {
  it('returns the handle of a disclosed author who holds one', () => {
    expect(authorHandle(ALICE, new Map([[ALICE, 'tealotter']]))).toBe('tealotter')
  })

  it('is undefined for a disclosed author with no name', () => {
    expect(authorHandle(BOB, new Map([[ALICE, 'tealotter']]))).toBeUndefined()
  })

  // The impersonation case: a pseudonymous author picks a display name that is byte-for-byte a
  // handle someone else holds. There is no id behind it, so nothing to key the map on, and the
  // name must never be treated as theirs.
  it('is undefined for a pseudonym that spells a real handle', () => {
    expect(authorHandle('tealotter', new Map([[ALICE, 'tealotter']]))).toBeUndefined()
  })
})

describe('authorLabel', () => {
  const handles = new Map([[ALICE, 'tealotter']])

  it('draws the handle in place of the id', () => {
    expect(authorLabel(ALICE, handles)).toBe('tealotter')
  })

  it('falls back to the truncated id when there is no handle', () => {
    const label = authorLabel(BOB, handles)
    expect(label).not.toBe(BOB)
    expect(label).toContain('…')
    expect(label.length).toBe(24)
  })

  it('draws a pseudonym as itself, never as a handle', () => {
    expect(authorLabel('night-owl', handles)).toBe('night-owl')
    expect(authorLabel('tealotter', handles)).toBe('tealotter')
  })

  it('respects a narrower budget for the id fallback', () => {
    expect(authorLabel(BOB, handles, 20).length).toBe(20)
  })

  // `max` bounds the fallback only. A handle is at most 32 bytes and every surface clamps to one
  // line, so truncating it here would corrupt a name the platform could still have fitted.
  it('never truncates a handle, whatever the budget', () => {
    const long = 'a'.repeat(32)
    expect(authorLabel(ALICE, new Map([[ALICE, long]]), 20)).toBe(long)
  })

  it('shows the id while lookups are still in flight', () => {
    expect(authorLabel(ALICE, new Map())).toBe(authorLabel(ALICE, new Map(), 24))
    expect(authorLabel(ALICE, new Map())).toContain('…')
  })
})
