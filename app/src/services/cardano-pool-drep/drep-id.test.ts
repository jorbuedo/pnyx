import {Cip129} from '@evolution-sdk/cips'
import {bech32} from '@pnyx/crypto'
import {describe, expect, it} from 'vitest'
import {drepTargetBech32, drepTargetsMatch, parseDRepTarget} from './drep-id'
import {hexToBytes} from './http'

const HASH_HEX = 'a5b45515a3ff8cb7c02ce351834da324eb6dfc41b5779cb5e6b832aa'
const HASH = hexToBytes(HASH_HEX)

// Both spellings of the same key-hash credential.
const CIP129_ID = Cip129.drepBech32(HASH, false)
const CIP105_ID = bech32.encode('drep', bech32.toWords(HASH), 1023)
const CIP105_SCRIPT_ID = bech32.encode('drep_script', bech32.toWords(HASH), 1023)

describe('parseDRepTarget', () => {
  it('parses CIP-129 and CIP-105 spellings of the same key hash to one canonical form', () => {
    const a = parseDRepTarget(CIP129_ID)
    const b = parseDRepTarget(CIP105_ID)
    expect(a).toEqual({kind: 'key', hashHex: HASH_HEX})
    expect(b).toEqual({kind: 'key', hashHex: HASH_HEX})
    // The raw strings differ — string equality would have called these two different DReps.
    expect(CIP129_ID).not.toBe(CIP105_ID)
  })

  it('parses a CIP-105 script id as a script credential', () => {
    expect(parseDRepTarget(CIP105_SCRIPT_ID)).toEqual({kind: 'script', hashHex: HASH_HEX})
    expect(parseDRepTarget(Cip129.drepBech32(HASH, true))).toEqual({kind: 'script', hashHex: HASH_HEX})
  })

  it('parses the Koios system literals case-insensitively', () => {
    expect(parseDRepTarget('drep_always_abstain')).toEqual({kind: 'abstain'})
    expect(parseDRepTarget('ABSTAIN')).toEqual({kind: 'abstain'})
    expect(parseDRepTarget('drep_always_no_confidence')).toEqual({kind: 'no_confidence'})
    expect(parseDRepTarget('no-confidence')).toEqual({kind: 'no_confidence'})
  })

  it('returns null for garbage, wrong hrp, and non-drep CIP-129 credentials', () => {
    expect(parseDRepTarget('')).toBeNull()
    expect(parseDRepTarget('not-an-id')).toBeNull()
    expect(parseDRepTarget('pool1abc')).toBeNull()
    expect(parseDRepTarget(Cip129.ccHotBech32(HASH, false))).toBeNull()
  })
})

describe('drepTargetsMatch', () => {
  it('matches across CIP-105/CIP-129 spellings and system targets', () => {
    expect(drepTargetsMatch(parseDRepTarget(CIP129_ID), parseDRepTarget(CIP105_ID))).toBe(true)
    expect(drepTargetsMatch({kind: 'abstain'}, {kind: 'abstain'})).toBe(true)
    expect(drepTargetsMatch({kind: 'abstain'}, {kind: 'no_confidence'})).toBe(false)
    expect(drepTargetsMatch(parseDRepTarget(CIP105_ID), parseDRepTarget(CIP105_SCRIPT_ID))).toBe(false)
    expect(drepTargetsMatch(null, {kind: 'abstain'})).toBe(false)
  })
})

describe('drepTargetBech32', () => {
  it('round-trips a key target to the CIP-129 id; system targets have no id', () => {
    expect(drepTargetBech32({kind: 'key', hashHex: HASH_HEX})).toBe(CIP129_ID)
    expect(drepTargetBech32({kind: 'abstain'})).toBeNull()
    expect(drepTargetBech32({kind: 'no_confidence'})).toBeNull()
  })
})
