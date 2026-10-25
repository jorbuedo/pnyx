import {describe, expect, it} from 'vitest'
import {misroutedAssets, misroutedMessage, requestedAssetIds} from './agent-asset-split'

const PROG = '0b5f7fd473c249f72fb0f4fae1bf78773ab223defdb99b0746d8150b.54455354'
const ORDINARY = '27acf1ed0a8d9ade69ca32989aee25b2f40e77188b12e082447b491e.4845415f50524f50'
const out = (...pairs: readonly (readonly [string, bigint])[]) => ({amounts: new Map(pairs)})

describe('requestedAssetIds', () => {
  it('collects every named asset across outputs, once', () => {
    expect(requestedAssetIds([out(['', 2_000_000n], [PROG, 5n]), out([PROG, 7n], [ORDINARY, 1n])])).toEqual([
      PROG,
      ORDINARY,
    ])
  })

  it('ignores lovelace — it funds the fee and is never programmable', () => {
    expect(requestedAssetIds([out(['', 2_000_000n])])).toEqual([])
  })

  // An agent enumerating a basket per recipient writes plenty of zeroes; refusing a build over one
  // would be refusing something nobody asked for.
  it('ignores a zero allocation, which is not a request', () => {
    expect(requestedAssetIds([out([PROG, 0n])])).toEqual([])
  })
})

describe('misroutedAssets', () => {
  const programmableIds = new Set([PROG])

  it('the ordinary builder cannot carry a programmable token', () => {
    expect(misroutedAssets({outputs: [out([PROG, 5n])], programmableIds, builder: 'ordinary'})).toEqual([PROG])
  })

  it('the programmable builder cannot carry an ordinary one', () => {
    expect(misroutedAssets({outputs: [out([ORDINARY, 5n])], programmableIds, builder: 'programmable'})).toEqual([
      ORDINARY,
    ])
  })

  it('a correctly routed basket has nothing misrouted, either way', () => {
    expect(misroutedAssets({outputs: [out([ORDINARY, 5n])], programmableIds, builder: 'ordinary'})).toEqual([])
    expect(misroutedAssets({outputs: [out([PROG, 5n])], programmableIds, builder: 'programmable'})).toEqual([])
  })

  // The rule the split turns on: the two must refuse each other rather than send the half they
  // understand. A mixed basket is refused by whichever builder receives it.
  it('refuses a mixed basket from both sides', () => {
    const outputs = [out([PROG, 5n], [ORDINARY, 1n])]
    expect(misroutedAssets({outputs, programmableIds, builder: 'ordinary'})).toEqual([PROG])
    expect(misroutedAssets({outputs, programmableIds, builder: 'programmable'})).toEqual([ORDINARY])
  })

  // An unknown id is ordinary. Guessing "programmable" would refuse ordinary sends of tokens the
  // wallet simply holds none of, and the ordinary builder reports that accurately by itself.
  it('treats an id the account holds none of as ordinary', () => {
    expect(misroutedAssets({outputs: [out([ORDINARY, 5n])], programmableIds: new Set(), builder: 'ordinary'})).toEqual(
      [],
    )
  })
})

describe('misroutedMessage', () => {
  // ⚠️ The message this replaces was "this wallet does not hold enough for that transfer and its
  // fee" — false for a token the wallet holds, and it invited retrying with smaller amounts for ever.
  it('names the asset and the tool that can send it', () => {
    const m = misroutedMessage([PROG], 'ordinary')
    expect(m).toContain(PROG)
    expect(m).toContain('cardano_buildProgrammableTransfer')
    expect(m).not.toContain('not hold enough')
  })

  it('points the other way for the programmable builder', () => {
    const m = misroutedMessage([ORDINARY], 'programmable')
    expect(m).toContain(ORDINARY)
    expect(m).toContain('cardano_buildTransfer')
  })
})
