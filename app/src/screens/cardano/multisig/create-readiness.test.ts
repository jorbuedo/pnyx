import {XpubHex} from '@evolution-sdk/review/Brands'
import {describe, expect, it} from 'vitest'
import {blockerMessageKey, createReadiness} from './create-readiness'

const roster = [
  {tag: 'cosigner#0', name: 'Jordi', accountXpubHex: XpubHex('a'.repeat(128))},
  {tag: 'cosigner#1', name: 'Alex', accountXpubHex: XpubHex('b'.repeat(128))},
]

const base = {name: 'Rent pot', draftCount: 2, roster, templateValid: true, problems: []}

describe('createReadiness', () => {
  it('is ready when the form is complete', () => {
    expect(createReadiness(base)).toEqual({kind: 'ready'})
  })

  it('asks for a name when it was cleared, whitespace included', () => {
    expect(createReadiness({...base, name: '   '})).toEqual({kind: 'blocked', reason: 'no-name'})
  })

  it('asks for a co-signer before complaining about the policy', () => {
    // Both are wrong here. Adding a co-signer is what makes the quorum question
    // mean anything, so that is the one to ask for.
    expect(createReadiness({...base, draftCount: 0, roster: null, templateValid: false})).toEqual({
      kind: 'blocked',
      reason: 'no-cosigners',
    })
  })

  it('distinguishes an unusable row from an empty roster', () => {
    expect(createReadiness({...base, roster: null})).toEqual({kind: 'blocked', reason: 'incomplete-cosigner'})
  })

  it('reports the policy when the quorum or the window does not compile', () => {
    expect(createReadiness({...base, templateValid: false})).toEqual({kind: 'blocked', reason: 'policy'})
  })

  it('reports validated problems last, once the form itself is well-formed', () => {
    expect(createReadiness({...base, problems: [{kind: 'duplicate-xpub', name: 'Alex'}]})).toEqual({
      kind: 'blocked',
      reason: 'problems',
    })
  })
})

describe('blockerMessageKey', () => {
  it('has a message for every blocker the screen must explain', () => {
    for (const reason of ['no-name', 'no-cosigners', 'incomplete-cosigner', 'policy'] as const) {
      expect(blockerMessageKey(reason)).toMatch(/^multisig\.create\./)
    }
  })

  it('says nothing for a problem that already has its own callout', () => {
    // A duplicate key is named, with the co-signer, in a callout above the form.
    expect(blockerMessageKey('problems')).toBeNull()
  })
})
