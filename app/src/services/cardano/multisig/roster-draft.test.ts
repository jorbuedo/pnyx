import {Either} from 'effect'
import {describe, expect, it, vi} from 'vitest'
import {
  addBlankDraft,
  adoptRestoredDrafts,
  appendCoSigner,
  clearDraft,
  draftsToRoster,
  fillFromOwnWallet,
  hasDuplicateKey,
  initialDrafts,
  inspectDrafts,
  isBlank,
  newDraft,
  parseDraftKey,
  removeDraft,
  updateDraft,
  upsertSelfDraft,
} from './roster-draft'
import {encodeAccountXvk, encodeSharedKey, SHARED_PREFIX} from './shared-key'
import {tagAt} from './template'

const XPUB_A = 'aa'.repeat(64)
const XPUB_B = 'bb'.repeat(64)
const bech32A = Either.getOrThrow(encodeAccountXvk(XPUB_A))

describe('parseDraftKey', () => {
  it('accepts the CIP-5 bech32 form', () => {
    expect(Either.getOrThrow(parseDraftKey(bech32A))).toBe(XPUB_A)
  })

  it('accepts bare hex and lowercases it', () => {
    expect(Either.getOrThrow(parseDraftKey(XPUB_A.toUpperCase()))).toBe(XPUB_A)
  })

  it('tolerates whitespace', () => {
    expect(Either.getOrThrow(parseDraftKey(`  ${bech32A}  `))).toBe(XPUB_A)
  })

  it('reports an empty key as empty, not malformed', () => {
    expect(parseDraftKey('   ')).toEqual(Either.left('empty'))
  })

  it('rejects a stake key pasted into an account-key field', () => {
    const stake = Either.getOrThrow(encodeSharedKey(SHARED_PREFIX.stakeVkh, 'cd'.repeat(28)))
    expect(parseDraftKey(stake)).toEqual(Either.left('bad-key'))
  })

  it('rejects hex of the wrong length', () => {
    expect(parseDraftKey('aa'.repeat(32))).toEqual(Either.left('bad-key'))
  })

  it('rejects prose', () => {
    expect(parseDraftKey('my key')).toEqual(Either.left('bad-key'))
  })
})

describe('inspectDrafts', () => {
  it('flags a valid key with a missing name', () => {
    const rows = inspectDrafts([newDraft({name: '  ', key: XPUB_A})])
    expect(rows[0]?.problem).toBe('no-name')
    expect(rows[0]?.accountXpubHex).toBe(XPUB_A)
  })

  it('reports a clean row as problem-free', () => {
    expect(inspectDrafts([newDraft({name: 'Alice', key: bech32A})])[0]?.problem).toBeNull()
  })
})

describe('draftsToRoster', () => {
  it('assigns tags by final position and trims names', () => {
    const drafts = [newDraft({name: ' Alice ', key: XPUB_A, isSelf: true}), newDraft({name: 'Bob', key: XPUB_B})]
    expect(draftsToRoster(drafts)).toEqual([
      {tag: tagAt(0), name: 'Alice', accountXpubHex: XPUB_A, isSelf: true},
      {tag: tagAt(1), name: 'Bob', accountXpubHex: XPUB_B},
    ])
  })

  it('returns null when any row is unusable', () => {
    expect(draftsToRoster([newDraft({name: 'Alice', key: XPUB_A}), newDraft({name: 'Bob', key: 'junk'})])).toBeNull()
  })

  it('returns null for a fresh editor', () => {
    expect(draftsToRoster(initialDrafts())).toBeNull()
  })
})

describe('removeDraft', () => {
  it('removes the addressed row', () => {
    const a = newDraft({name: 'Alice', key: XPUB_A})
    const b = newDraft({name: 'Bob', key: XPUB_B})
    expect(removeDraft([a, b], a.id).map((d) => d.name)).toEqual(['Bob'])
  })

  it('leaves a blank row rather than an empty editor', () => {
    // An editor with no rows offers no way back to a usable state.
    const only = newDraft({name: 'Alice', key: XPUB_A})
    const next = removeDraft([only], only.id)
    expect(next).toHaveLength(1)
    expect(isBlank(next[0] as (typeof next)[number])).toBe(true)
  })

  it('ignores an unknown id', () => {
    const a = newDraft({name: 'Alice', key: XPUB_A})
    expect(removeDraft([a], 'nope')).toHaveLength(1)
  })
})

describe('upsertSelfDraft', () => {
  it('drops the untouched starter row', () => {
    // The regression: the blank row survived, so `Create` stayed disabled with
    // nothing on screen saying why.
    const next = upsertSelfDraft(initialDrafts(), {name: 'You', accountXpubHex: XPUB_A})
    expect(next).toHaveLength(1)
    expect(draftsToRoster(next)).not.toBeNull()
  })

  it('puts self first and keeps the others in order', () => {
    const drafts = [newDraft({name: 'Bob', key: XPUB_B})]
    const next = upsertSelfDraft(drafts, {name: 'You', accountXpubHex: XPUB_A})
    expect(next.map((d) => d.name)).toEqual(['You', 'Bob'])
    expect(next[0]?.isSelf).toBe(true)
  })

  it('replaces a previous self row instead of adding a second', () => {
    const once = upsertSelfDraft(initialDrafts(), {name: 'You', accountXpubHex: XPUB_A})
    const twice = upsertSelfDraft(once, {name: 'You', accountXpubHex: XPUB_B})
    expect(twice.filter((d) => d.isSelf)).toHaveLength(1)
    expect(twice[0]?.key).toBe(XPUB_B)
  })
})

describe('hasDuplicateKey', () => {
  it('spots a key already in the roster', () => {
    const drafts = [newDraft({name: 'Alice', key: bech32A})]
    expect(hasDuplicateKey(drafts, XPUB_A)).toBe(true)
    expect(hasDuplicateKey(drafts, XPUB_B)).toBe(false)
  })

  it('ignores the row being edited', () => {
    const a = newDraft({name: 'Alice', key: XPUB_A})
    expect(hasDuplicateKey([a], XPUB_A, a.id)).toBe(false)
  })

  it('matches case-insensitively across the bech32 and hex forms', () => {
    expect(hasDuplicateKey([newDraft({name: 'Alice', key: bech32A})], XPUB_A.toUpperCase())).toBe(true)
  })
})

describe('addBlankDraft / updateDraft', () => {
  it('appends a blank row', () => {
    expect(addBlankDraft(initialDrafts())).toHaveLength(2)
  })

  it('patches only the addressed row', () => {
    const a = newDraft({name: 'Alice', key: ''})
    const b = newDraft({name: 'Bob', key: ''})
    const next = updateDraft([a, b], b.id, {key: XPUB_B})
    expect(next[0]?.key).toBe('')
    expect(next[1]?.key).toBe(XPUB_B)
  })
})

describe('appendCoSigner', () => {
  it('fills the starter blank rather than appending past it', () => {
    // Appending would leave the untouched blank row in the middle, keeping the
    // form invalid for a reason nothing on screen explains.
    const next = appendCoSigner(initialDrafts(), {name: 'Bob', accountXpubHex: XPUB_B})
    expect(next).toHaveLength(1)
    expect(next[0]?.name).toBe('Bob')
  })

  it('appends when every row is in use', () => {
    const drafts = [newDraft({name: 'Alice', key: XPUB_A})]
    const next = appendCoSigner(drafts, {name: 'Bob', accountXpubHex: XPUB_B})
    expect(next.map((d) => d.name)).toEqual(['Alice', 'Bob'])
  })

  it('fills only the first blank', () => {
    const drafts = [newDraft({name: '', key: ''}), newDraft({name: '', key: ''})]
    const next = appendCoSigner(drafts, {name: 'Bob', accountXpubHex: XPUB_B})
    expect(next.map((d) => d.name)).toEqual(['Bob', ''])
  })
})

describe('adoptRestoredDrafts', () => {
  // The ids in a stored draft were minted by a counter that restarts at zero
  // every app start, so they are exactly the ids this session is about to mint.
  const STORED = [
    {id: 'd1', name: 'Alice', key: XPUB_A, isSelf: true},
    {id: 'd2', name: 'Bob', key: XPUB_B},
  ] as const

  it('keeps every row and every field but the id', () => {
    const adopted = adoptRestoredDrafts(STORED)
    expect(adopted.map((d) => [d.name, d.key, d.isSelf])).toEqual([
      ['Alice', XPUB_A, true],
      ['Bob', XPUB_B, undefined],
    ])
  })

  /**
   * The counter has to start where a real app start leaves it — zero — or the
   * collision cannot happen at all and the test proves nothing. Every id in this
   * block therefore comes from a freshly loaded module, not the one above.
   */
  const freshSession = async () => {
    vi.resetModules()
    return import('./roster-draft')
  }

  it('is what stops a restored row and a new one sharing an id', async () => {
    const session = await freshSession()
    // What the screen used to do: hand the stored rows straight to the editor.
    const naive = session.addBlankDraft([...STORED])
    expect(naive.map((d) => d.id)).toEqual(['d1', 'd2', 'd1'])
  })

  it('leaves no id a later row can collide with', async () => {
    const session = await freshSession()
    const ids = session.addBlankDraft(session.adoptRestoredDrafts(STORED)).map((d) => d.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('clearDraft', () => {
  it('empties the row in place, keeping its position and id', () => {
    const drafts = [newDraft({name: 'Jordi', key: 'a'.repeat(128)}), newDraft({name: 'Alex', key: 'b'.repeat(128)})]
    const cleared = clearDraft(drafts, drafts[0]?.id ?? '')
    expect(cleared).toHaveLength(2)
    expect(cleared[0]).toEqual({id: drafts[0]?.id, name: '', key: ''})
    expect(cleared[1]).toEqual(drafts[1])
  })

  it('drops isSelf — a cleared row is no longer this wallet', () => {
    // Otherwise the row keeps its fields locked with nothing in them, and the
    // roster still claims our key is in a wallet it is not.
    const drafts = [newDraft({name: 'Me', key: 'a'.repeat(128), isSelf: true})]
    const cleared = clearDraft(drafts, drafts[0]?.id ?? '')
    expect(cleared[0]?.isSelf).toBeUndefined()
  })

  it('leaves every other row untouched when the id is not there', () => {
    const drafts = [newDraft({name: 'Jordi', key: 'a'.repeat(128)})]
    expect(clearDraft(drafts, 'nope')).toEqual(drafts)
  })
})

describe('draftsToRoster — blank rows are slots', () => {
  const KEY = 'a'.repeat(128)
  const KEY2 = 'b'.repeat(128)

  it('skips a blank row rather than refusing the roster', () => {
    // The editor always keeps one row to type into, and the first cannot be
    // removed — so a blank row must not read as a broken co-signer.
    const drafts = [newDraft({name: 'Jordi', key: KEY}), newDraft({name: '', key: ''})]
    const roster = draftsToRoster(drafts)
    expect(roster).toEqual([{tag: 'cosigner#0', name: 'Jordi', accountXpubHex: KEY}])
  })

  it('tags by position among the rows that count', () => {
    const drafts = [
      newDraft({name: '', key: ''}),
      newDraft({name: 'Jordi', key: KEY}),
      newDraft({name: 'Alex', key: KEY2}),
    ]
    expect(draftsToRoster(drafts)?.map((c) => c.tag)).toEqual(['cosigner#0', 'cosigner#1'])
  })

  it('still refuses a row with a name and no key, or a key and no name', () => {
    expect(draftsToRoster([newDraft({name: 'Jordi', key: ''})])).toBeNull()
    expect(draftsToRoster([newDraft({name: '', key: KEY})])).toBeNull()
  })

  it('is null when every row is blank', () => {
    expect(draftsToRoster([newDraft({name: '', key: ''})])).toBeNull()
  })
})

describe('fillFromOwnWallet', () => {
  const KEY = 'a'.repeat(128)
  const KEY2 = 'b'.repeat(128)

  it('fills the row that was pressed, in place', () => {
    const drafts = [newDraft({name: 'Alex', key: KEY2}), newDraft({name: '', key: ''})]
    const filled = fillFromOwnWallet(drafts, drafts[1]?.id ?? '', {name: 'Mine', accountXpubHex: KEY})
    expect(filled[0]).toEqual(drafts[0])
    expect(filled[1]).toEqual({id: drafts[1]?.id, name: 'Mine', key: KEY})
  })

  it('claims nothing about ownership — that follows the key, not the picker', () => {
    // A row filled here and the identical key typed by hand must read the same, and
    // two of your own wallets in one roster are both ours. `draftsToRoster` decides
    // it from `localWalletForKey`.
    const drafts = [newDraft({name: '', key: ''})]
    const filled = fillFromOwnWallet(drafts, drafts[0]?.id ?? '', {name: 'Mine', accountXpubHex: KEY})
    expect(filled[0]).not.toHaveProperty('isSelf')
  })

  it('leaves the roster untouched for an id that is not there', () => {
    const drafts = [newDraft({name: 'Alex', key: KEY2})]
    expect(fillFromOwnWallet(drafts, 'nope', {name: 'Mine', accountXpubHex: KEY})).toEqual(drafts)
  })
})

describe('draftsToRoster — ownership', () => {
  const MINE = 'a'.repeat(128)
  const THEIRS = 'b'.repeat(128)

  it('marks every row whose key we hold, not just one', () => {
    // Two of your own wallets in one shared wallet is a real arrangement, and the
    // old single `isSelf` flag could only ever mark the first.
    const drafts = [
      newDraft({name: 'Me', key: MINE}),
      newDraft({name: 'Also me', key: 'c'.repeat(128)}),
      newDraft({name: 'Alex', key: THEIRS}),
    ]
    const roster = draftsToRoster(drafts, (key) => key !== THEIRS)
    expect(roster?.map((c) => c.isSelf)).toEqual([true, true, undefined])
  })

  it('falls back to the draft flag when no test is given', () => {
    const drafts = [newDraft({name: 'Me', key: MINE, isSelf: true}), newDraft({name: 'Alex', key: THEIRS})]
    expect(draftsToRoster(drafts)?.map((c) => c.isSelf)).toEqual([true, undefined])
  })
})
