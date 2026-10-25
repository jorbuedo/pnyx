// What a transaction does to this wallet. The rules worth pinning are about *not knowing*: a partial
// view must report itself as partial, because its figures are wrong rather than rough.
import {describe, expect, it} from 'vitest'
import {describeMidnightGap, midnightTxEffect} from './midnight-effect.js'
import type {MidnightTxFacts} from './midnight-facts.js'

const OURS = 'aa'.repeat(32)
const THEIRS = 'bb'.repeat(32)
const NIGHT = '00'.repeat(32)

const utxo = (value: bigint, owner: string, colour = NIGHT) => ({colour, value, owner})

const facts = (over: Partial<MidnightTxFacts> = {}): MidnightTxFacts => ({
  networkId: 'preprod',
  intents: [],
  shieldedOutputs: 0,
  hasShielded: false,
  understood: true,
  ...over,
})

const oneIntent = (
  inputs: readonly ReturnType<typeof utxo>[],
  outputs: readonly ReturnType<typeof utxo>[],
  over: Record<string, unknown> = {},
) =>
  facts({
    intents: [
      {
        segment: 1,
        ttlSecs: 1_800_000_000,
        guaranteed: {inputs: [], outputs: []},
        fallible: {inputs, outputs},
        calls: [],
        deploys: [],
        otherActions: 0,
        ...over,
      },
    ],
  })

describe('midnightTxEffect', () => {
  it('nets our own inputs and outputs into a per-token delta', () => {
    const effect = midnightTxEffect({
      facts: oneIntent([utxo(5_000n, OURS)], [utxo(2_000n, THEIRS), utxo(3_000n, OURS)]),
      ourAddresses: [OURS],
    })
    // Spent 5,000, got 3,000 back as change: down 2,000.
    expect(effect.delta.get(NIGHT)).toBe(-2_000n)
    expect(effect.understood).toBe(true)
  })

  it('⚠️ does not count another wallet’s input as ours — that is a co-funder, not our spend', () => {
    const effect = midnightTxEffect({
      facts: oneIntent([utxo(2_000n, OURS), utxo(4_000n, THEIRS)], [utxo(6_000n, 'cc'.repeat(32))]),
      ourAddresses: [OURS],
    })
    expect(effect.delta.get(NIGHT)).toBe(-2_000n)
  })

  it('omits a token whose net is zero, so a self-send is not listed as a movement', () => {
    const effect = midnightTxEffect({
      facts: oneIntent([utxo(1_000n, OURS)], [utxo(1_000n, OURS)]),
      ourAddresses: [OURS],
    })
    expect(effect.delta.has(NIGHT)).toBe(false)
  })

  it('lists outputs going to addresses we do not control', () => {
    const effect = midnightTxEffect({
      facts: oneIntent([utxo(5_000n, OURS)], [utxo(2_000n, THEIRS)]),
      ourAddresses: [OURS],
    })
    expect(effect.toOthers.map((one) => one.value)).toEqual([2_000n])
  })

  it('counts the segments, because more than one means several parties or several jobs', () => {
    const two = facts({
      intents: [
        {
          segment: 1,
          ttlSecs: 1_800_000_000,
          guaranteed: {inputs: [], outputs: []},
          fallible: {inputs: [], outputs: []},
          calls: [],
          deploys: [],
          otherActions: 0,
        },
        {
          segment: 2,
          ttlSecs: 1_800_000_000,
          guaranteed: {inputs: [], outputs: []},
          fallible: {inputs: [], outputs: []},
          calls: [],
          deploys: [],
          otherActions: 0,
        },
      ],
    })
    expect(midnightTxEffect({facts: two, ourAddresses: [OURS]}).segments).toBe(2)
  })

  it('counts a decrypted shielded output as ours — decrypting it is what proves that', () => {
    const effect = midnightTxEffect({
      facts: facts({hasShielded: true, shieldedOutputs: 1}),
      ourAddresses: [OURS],
      shielded: {decrypted: [{colour: NIGHT, value: 700n}], undecryptable: 0},
    })
    expect(effect.delta.get(NIGHT)).toBe(700n)
    expect(effect.understood).toBe(true)
  })

  it('⚠️ reports undecryptable shielded outputs as a gap, not as somebody else’s payment', () => {
    // "We cannot tell" is not "not ours". Treating it as a stranger's would report a receipt we
    // cannot see as a payment out.
    const effect = midnightTxEffect({
      facts: facts({hasShielded: true, shieldedOutputs: 3}),
      ourAddresses: [OURS],
      shielded: {decrypted: [{colour: NIGHT, value: 700n}], undecryptable: 2},
    })
    expect(effect.understood).toBe(false)
    expect(effect.gaps).toContainEqual({kind: 'shielded-not-ours', count: 2})
    expect(effect.toOthers).toHaveLength(0)
  })

  it('reports a shielded offer nobody even tried to decrypt as unaccounted for', () => {
    const effect = midnightTxEffect({
      facts: facts({hasShielded: true, shieldedOutputs: 2}),
      ourAddresses: [OURS],
    })
    expect(effect.gaps).toContainEqual({kind: 'shielded-not-ours', count: 2})
  })

  it('carries an unreadable transaction through as not understood', () => {
    const effect = midnightTxEffect({facts: facts({understood: false}), ourAddresses: [OURS]})
    expect(effect.understood).toBe(false)
    expect(effect.gaps).toContainEqual({kind: 'unreadable-transaction'})
  })

  it('⚠️ refuses to attribute anything when we do not know our own addresses', () => {
    // With an empty set every output looks like a stranger's, so the delta would read as a total loss.
    const effect = midnightTxEffect({facts: oneIntent([utxo(5_000n, OURS)], []), ourAddresses: []})
    expect(effect.understood).toBe(false)
    expect(effect.gaps).toContainEqual({kind: 'own-addresses-unknown'})
  })

  it('counts an unreadable entry as a gap rather than as a zero', () => {
    const effect = midnightTxEffect({
      facts: oneIntent([{colour: '', value: 0n, owner: OURS}], []),
      ourAddresses: [OURS],
    })
    expect(effect.gaps).toContainEqual({kind: 'unreadable-entry', count: 1})
    expect(effect.understood).toBe(false)
  })

  it('matches our addresses case-insensitively', () => {
    const effect = midnightTxEffect({
      facts: oneIntent([], [utxo(1_000n, OURS.toUpperCase())]),
      ourAddresses: [OURS],
    })
    // The facts reader lowercases, so this is belt and braces — but a mismatch here would silently
    // report our own change as a payment to a stranger.
    expect(effect.toOthers).toHaveLength(1)
    const upper = midnightTxEffect({facts: oneIntent([], [utxo(1_000n, OURS)]), ourAddresses: [OURS.toUpperCase()]})
    expect(upper.delta.get(NIGHT)).toBe(1_000n)
  })

  it('every gap has words a person could act on', () => {
    for (const gap of [
      {kind: 'unreadable-transaction'} as const,
      {kind: 'shielded-not-ours', count: 2} as const,
      {kind: 'unreadable-entry', count: 1} as const,
      {kind: 'own-addresses-unknown'} as const,
    ]) {
      expect(describeMidnightGap(gap).length).toBeGreaterThan(20)
    }
  })
})
