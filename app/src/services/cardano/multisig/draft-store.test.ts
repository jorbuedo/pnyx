import {describe, expect, it} from 'vitest'
import {decodeDraft, encodeDraft, isWorthKeeping, type MultisigDraft} from './draft-store'

const draft = (over: Partial<MultisigDraft> = {}): MultisigDraft => ({
  walletName: 'Council',
  rows: [
    {id: 'd1', name: 'Me', key: 'ab'.repeat(64), isSelf: true},
    {id: 'd2', name: 'Ana', key: 'cd'.repeat(64)},
  ],
  quorumKind: 'atLeast',
  required: '2',
  fromSlot: '',
  untilSlot: '',
  ...over,
})

describe('encodeDraft / decodeDraft', () => {
  it('round-trips a part-built wallet', () => {
    expect(decodeDraft(encodeDraft(draft()))).toEqual(draft())
  })

  it('keeps `isSelf` only where it was set', () => {
    // Position carries no meaning in the roster editor, so the self row has to
    // identify itself. Losing the flag would let the user add themselves twice.
    const decoded = decodeDraft(encodeDraft(draft()))
    expect(decoded?.rows[0]?.isSelf).toBe(true)
    expect(decoded?.rows[1]?.isSelf).toBeUndefined()
  })

  it('is null for anything it cannot read, rather than a half-built draft', () => {
    // A draft seeds a spending policy. Half of one is worse than none.
    for (const raw of [null, '', 'not json', '{}', '[]', 'null']) {
      expect(decodeDraft(raw)).toBeNull()
    }
  })

  it('discards a draft written by a different version', () => {
    // Discarded, not migrated: an older shape's rows could mean something else,
    // and guessing puts the wrong key in a policy.
    const stored = JSON.parse(encodeDraft(draft())) as Record<string, unknown>
    expect(decodeDraft(JSON.stringify({...stored, version: 99}))).toBeNull()
    expect(decodeDraft(JSON.stringify({...stored, version: undefined}))).toBeNull()
  })

  it('drops a row it cannot read, and the draft when none survive', () => {
    const stored = JSON.parse(encodeDraft(draft())) as Record<string, unknown>
    const withJunk = JSON.stringify({...stored, rows: [{id: 'd1', name: 'Me', key: 'ab'}, {name: 'no id'}, null, 7]})
    expect(decodeDraft(withJunk)?.rows).toEqual([{id: 'd1', name: 'Me', key: 'ab'}])

    expect(decodeDraft(JSON.stringify({...stored, rows: [{name: 'no id'}]}))).toBeNull()
    expect(decodeDraft(JSON.stringify({...stored, rows: []}))).toBeNull()
  })

  it('reads a row with missing text fields as empty, never undefined', () => {
    // These feed straight into TextInput values; `undefined` there flips the input
    // to uncontrolled and the row silently stops updating.
    const stored = JSON.parse(encodeDraft(draft())) as Record<string, unknown>
    const decoded = decodeDraft(JSON.stringify({...stored, walletName: 42, rows: [{id: 'd1'}]}))
    expect(decoded?.walletName).toBe('')
    expect(decoded?.rows[0]).toEqual({id: 'd1', name: '', key: ''})
  })
})

describe('isWorthKeeping', () => {
  it('is false for an untouched editor', () => {
    // Writing this would resurrect a blank form over a wallet just finished.
    expect(isWorthKeeping({...draft(), walletName: '', rows: [{id: 'd1', name: '', key: ''}]})).toBe(false)
    expect(isWorthKeeping({...draft(), walletName: '   ', rows: [{id: 'd1', name: ' ', key: ''}]})).toBe(false)
  })

  it('is true once there is a name or anything in a row', () => {
    expect(isWorthKeeping({...draft(), rows: [{id: 'd1', name: '', key: ''}]})).toBe(true)
    expect(isWorthKeeping({...draft(), walletName: '', rows: [{id: 'd1', name: 'Ana', key: ''}]})).toBe(true)
    expect(isWorthKeeping({...draft(), walletName: '', rows: [{id: 'd1', name: '', key: 'ab'}]})).toBe(true)
  })
})
