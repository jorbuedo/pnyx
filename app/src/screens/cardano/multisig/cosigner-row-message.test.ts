import {describe, expect, it} from 'vitest'
import {inspectDrafts, newDraft} from '../../../services/cardano/multisig/roster-draft'
import {coSignerRowMessages} from './cosigner-row-message'

const XPUB = 'aa'.repeat(64)

/** Through the real inspector, so the row states here are ones the screen can reach. */
const rowFor = (name: string, key: string) => {
  const row = inspectDrafts([newDraft({name, key})])[0]
  if (row === undefined) throw new Error('inspectDrafts returned nothing')
  return row
}

describe('coSignerRowMessages', () => {
  it('hints the format while the key has not parsed', () => {
    expect(coSignerRowMessages(rowFor('', ''))).toEqual({
      name: null,
      key: {key: 'multisig.create.coSignerKeyHint', tone: 'default'},
    })
  })

  it('captions the hint neutrally, not as a warning about the value', () => {
    // The hint describes the format. Dressing it as a warning says the field is
    // wrong, which for an untouched row it is not.
    expect(coSignerRowMessages(rowFor('', '')).key?.tone).toBe('default')
  })

  it('replaces the hint with an error for a key that will not parse', () => {
    expect(coSignerRowMessages(rowFor('Alice', 'junk'))).toEqual({
      name: null,
      key: {key: 'multisig.create.errorInvalidKey', tone: 'error'},
    })
  })

  it('puts the missing name under the name field, not the key field', () => {
    expect(coSignerRowMessages(rowFor('  ', XPUB))).toEqual({
      name: {key: 'multisig.create.errorMissingName', tone: 'error'},
      key: null,
    })
  })

  it('says nothing at all about a row that is complete', () => {
    // The regression: the format hint stayed under every filled row for the rest
    // of the session, so a valid roster looked like a page of warnings.
    expect(coSignerRowMessages(rowFor('Alice', XPUB))).toEqual({name: null, key: null})
  })
})
