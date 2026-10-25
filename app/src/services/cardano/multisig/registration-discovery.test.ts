import {describe, expect, it} from 'vitest'
import {
  keyHashesOf,
  matchRegistrations,
  oldestPerCredential,
  type RegistrationRow,
  rowFromTxInfo,
} from './registration-discovery'

const MINE = '7530a88dab825420a0902e84cda669238c282e8f3b9ad35693424e13'
const THEIRS = 'bfb33a677e8485f564fb069c9d428acf9632c659d2b14097e633c26c'

const row = (over: Partial<RegistrationRow> = {}): RegistrationRow => ({
  txHash: 'aa',
  blockHeight: 100,
  name: 'Council',
  keyHashes: [MINE, THEIRS],
  scriptHashes: ['d40563fc'],
  participants: {},
  ...over,
})

describe('keyHashesOf', () => {
  it('collects leaves at any depth', () => {
    // Templates nest: `at_least 2 [sig, any [sig, sig]]` is ordinary.
    expect(
      keyHashesOf({
        type: 'atLeast',
        scripts: [
          {type: 'sig', keyHash: MINE},
          {type: 'any', scripts: [{type: 'sig', keyHash: THEIRS}]},
        ],
      }),
    ).toEqual([MINE, THEIRS])
  })

  it('lowercases, so a differently-cased publisher still matches', () => {
    expect(keyHashesOf({type: 'sig', keyHash: MINE.toUpperCase()})).toEqual([MINE])
  })

  it('is empty for a script with no leaves, and does not throw on junk', () => {
    expect(keyHashesOf(undefined)).toEqual([])
    expect(keyHashesOf({})).toEqual([])
    expect(keyHashesOf({type: 'sig', keyHash: ''})).toEqual([])
    expect(keyHashesOf({type: 'all', scripts: [] as const})).toEqual([])
  })
})

describe('matchRegistrations', () => {
  it('returns only registrations naming one of our credentials', () => {
    const mine = row({txHash: 'aa'})
    const other = row({txHash: 'bb', keyHashes: [THEIRS]})
    expect(matchRegistrations([mine, other], [MINE]).map((m) => m.txHash)).toEqual(['aa'])
  })

  it('orders oldest first — the rule, not a presentation choice', () => {
    const newer = row({txHash: 'new', blockHeight: 500})
    const older = row({txHash: 'old', blockHeight: 100})
    expect(matchRegistrations([newer, older], [MINE]).map((m) => m.txHash)).toEqual(['old', 'new'])
  })

  it('breaks a same-block tie deterministically', () => {
    // Two in one block is not a case the CIP resolves; picking stably beats
    // picking differently on each run.
    const a = row({txHash: 'a1', blockHeight: 7})
    const b = row({txHash: 'b2', blockHeight: 7})
    expect(matchRegistrations([b, a], [MINE]).map((m) => m.txHash)).toEqual(['a1', 'b2'])
    expect(matchRegistrations([a, b], [MINE]).map((m) => m.txHash)).toEqual(['a1', 'b2'])
  })

  it('says which credentials matched, deduped', () => {
    const both = row({keyHashes: [MINE, MINE, THEIRS]})
    expect(matchRegistrations([both], [MINE, THEIRS])[0]?.matched).toEqual([MINE, THEIRS])
  })

  it('matches nothing when we have no credentials', () => {
    expect(matchRegistrations([row()], [])).toEqual([])
  })
})

describe('oldestPerCredential', () => {
  it('lets the earliest registration keep a credential a later one also claims', () => {
    // The anti-phishing rule. There is a registration on mainnet named
    // "StealMulti"; publishing one naming somebody else's key costs nothing.
    const real = row({txHash: 'real', blockHeight: 100, name: 'Council'})
    const fake = row({txHash: 'fake', blockHeight: 900, name: 'Council (Official)'})
    const winners = oldestPerCredential(matchRegistrations([fake, real], [MINE]))
    expect(winners.get(MINE)?.txHash).toBe('real')
  })

  it('holds when the impostor is published first and the real wallet later', () => {
    // Stated plainly because it is the rule's actual limit: "oldest" is all the
    // chain can tell us, so an attacker who registers a credential *before* its
    // owner does wins. Nothing here pretends otherwise — the defence against that
    // is the invite, out of band.
    const fake = row({txHash: 'fake', blockHeight: 10})
    const real = row({txHash: 'real', blockHeight: 900})
    expect(oldestPerCredential(matchRegistrations([real, fake], [MINE])).get(MINE)?.txHash).toBe('fake')
  })
})

describe('rowFromTxInfo', () => {
  // `script_hash` identifies the wallet, which is how a result is recognised as one
  // already on this device.
  // Shaped exactly as Koios returned it for a real mainnet registration.
  const live = {
    tx_hash: '23113e8c',
    block_height: 11245053,
    metadata: {'1854': {name: 'StealMulti', types: ['payment', 'stake'], participants: {}}},
    native_scripts: [
      {
        script_hash: 'd40563fc',
        script_json: {
          type: 'any',
          scripts: [
            {type: 'sig', keyHash: MINE},
            {type: 'sig', keyHash: THEIRS},
          ],
        },
      },
    ],
  }

  it('reads a real Koios row', () => {
    expect(rowFromTxInfo(live)).toEqual({
      txHash: '23113e8c',
      blockHeight: 11245053,
      name: 'StealMulti',
      keyHashes: [MINE, THEIRS],
      scriptHashes: ['d40563fc'],
      participants: {},
    })
  })

  it('keeps participant names where the publisher wrote them', () => {
    const named = {...live, metadata: {'1854': {name: 'C', participants: {cosigner_0: {name: 'Ana'}}}}}
    expect(rowFromTxInfo(named)?.participants).toEqual({cosigner_0: {name: 'Ana'}})
  })

  it('is null for anything without a label-1854 record or without leaves', () => {
    // A stranger's metadata, shaped however they chose — a reader that assumed
    // its own format would be trusting the party the rule defends against.
    expect(rowFromTxInfo(null)).toBeNull()
    expect(rowFromTxInfo({})).toBeNull()
    expect(rowFromTxInfo({...live, metadata: {'674': {msg: 'hi'}}})).toBeNull()
    expect(rowFromTxInfo({...live, native_scripts: []})).toBeNull()
    expect(rowFromTxInfo({...live, block_height: 'soon'})).toBeNull()
  })

  it('survives a name or participants of the wrong type', () => {
    const junk = {...live, metadata: {'1854': {name: 42, participants: {a: 'not an object'}}}}
    expect(rowFromTxInfo(junk)?.name).toBeUndefined()
    expect(rowFromTxInfo(junk)?.participants).toEqual({a: {}})
  })
})
