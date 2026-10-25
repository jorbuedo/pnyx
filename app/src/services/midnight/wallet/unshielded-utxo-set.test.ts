import {describe, expect, it} from 'vitest'

import {
  applyUnshieldedEvent,
  type IndexedUnshieldedUtxo,
  parseValue,
  totalsByToken,
  type UnshieldedUtxo,
  utxoKey,
} from './unshielded-utxo-set'

const OURS = 'mn_addr_preprod1ours'
const THEIRS = 'mn_addr_preprod1theirs'
const NIGHT = '0100000000000000000000000000000000000000000000000000000000000000'

const utxo = (over: Partial<IndexedUnshieldedUtxo> = {}): IndexedUnshieldedUtxo => ({
  owner: OURS,
  tokenType: NIGHT,
  value: '1000000',
  intentHash: 'aa11',
  outputIndex: 0,
  ctime: 1_700_000_000,
  registeredForDustGeneration: false,
  ...over,
})

const empty: ReadonlyMap<string, UnshieldedUtxo> = new Map()

describe('parseValue', () => {
  it('reads a decimal string as atomic units', () => {
    expect(parseValue('1000000')).toBe(1_000_000n)
    expect(parseValue('0')).toBe(0n)
  })

  it('keeps precision a Number would lose', () => {
    expect(parseValue('9007199254740993')).toBe(9_007_199_254_740_993n)
  })

  it('refuses anything that is not a non-negative integer, rather than reading it as zero', () => {
    for (const bad of ['', '-1', '1.5', '1e6', ' 1', 'abc', '0x10']) expect(parseValue(bad)).toBeNull()
  })
})

describe('utxoKey', () => {
  it('identifies a UTxO by intent and output index, case-insensitively', () => {
    expect(utxoKey({intentHash: 'AA11', outputIndex: 2})).toBe(utxoKey({intentHash: 'aa11', outputIndex: 2}))
  })

  it('separates two outputs of the same intent', () => {
    expect(utxoKey({intentHash: 'aa11', outputIndex: 0})).not.toBe(utxoKey({intentHash: 'aa11', outputIndex: 1}))
  })
})

describe('applyUnshieldedEvent', () => {
  it('adds a created UTxO owned by us', () => {
    const set = applyUnshieldedEvent(empty, {createdUtxos: [utxo()]}, OURS)
    expect([...set.values()]).toEqual([
      {
        owner: OURS,
        tokenType: NIGHT,
        value: 1_000_000n,
        intentHash: 'aa11',
        outputIndex: 0,
        ctime: 1_700_000_000,
        registeredForDustGeneration: false,
      },
    ])
  })

  it('ignores an output paid to someone else in the same transaction', () => {
    // The change output of a transaction that pays us is in the same event.
    const set = applyUnshieldedEvent(empty, {createdUtxos: [utxo(), utxo({owner: THEIRS, outputIndex: 1})]}, OURS)
    expect(set.size).toBe(1)
    expect([...set.values()][0]?.outputIndex).toBe(0)
  })

  it('removes a UTxO when a later event spends it', () => {
    const created = applyUnshieldedEvent(empty, {createdUtxos: [utxo()]}, OURS)
    const spent = applyUnshieldedEvent(created, {spentUtxos: [utxo()]}, OURS)
    expect(spent.size).toBe(0)
  })

  it('does not leave a UTxO created and spent inside one transaction', () => {
    const set = applyUnshieldedEvent(empty, {createdUtxos: [utxo()], spentUtxos: [utxo()]}, OURS)
    expect(set.size).toBe(0)
  })

  it('ignores a spend of a UTxO that was never ours', () => {
    const created = applyUnshieldedEvent(empty, {createdUtxos: [utxo()]}, OURS)
    const after = applyUnshieldedEvent(created, {spentUtxos: [utxo({owner: THEIRS})]}, OURS)
    expect(after.size).toBe(1)
  })

  it('drops a UTxO whose value does not parse instead of counting it as zero', () => {
    const set = applyUnshieldedEvent(empty, {createdUtxos: [utxo({value: 'not-a-number'})]}, OURS)
    expect(set.size).toBe(0)
  })

  it('treats a re-created key as an update, so a replay cannot double-count', () => {
    const once = applyUnshieldedEvent(empty, {createdUtxos: [utxo()]}, OURS)
    const twice = applyUnshieldedEvent(once, {createdUtxos: [utxo()]}, OURS)
    expect(twice.size).toBe(1)
    expect(totalsByToken(twice).get(NIGHT)).toBe(1_000_000n)
  })

  it('leaves the input map untouched', () => {
    const before = applyUnshieldedEvent(empty, {createdUtxos: [utxo()]}, OURS)
    applyUnshieldedEvent(before, {spentUtxos: [utxo()]}, OURS)
    expect(before.size).toBe(1)
  })

  it('handles an event with neither list', () => {
    expect(applyUnshieldedEvent(empty, {}, OURS).size).toBe(0)
  })
})

describe('totalsByToken', () => {
  it('sums per token type', () => {
    const other = 'ff00000000000000000000000000000000000000000000000000000000000000'
    let set = applyUnshieldedEvent(empty, {createdUtxos: [utxo()]}, OURS)
    set = applyUnshieldedEvent(set, {createdUtxos: [utxo({outputIndex: 1, value: '2500000'})]}, OURS)
    set = applyUnshieldedEvent(set, {createdUtxos: [utxo({outputIndex: 2, tokenType: other, value: '7'})]}, OURS)
    expect(totalsByToken(set).get(NIGHT)).toBe(3_500_000n)
    expect(totalsByToken(set).get(other)).toBe(7n)
  })

  it('totals an empty set to no entries at all, not a zero for an assumed token', () => {
    expect([...totalsByToken(empty).entries()]).toEqual([])
  })
})
