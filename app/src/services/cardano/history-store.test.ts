import type {IndexedCardanoTx} from '@pnyx/tx-review'
import {describe, expect, it} from 'vitest'
import {cardanoDataRef} from './cardano-store'
import {cardanoChainIdFor} from './chain-id'
import {
  afterBlockCursor,
  deserializeIndexedTx,
  indexedTxToRow,
  mergeByHash,
  ownershipDelta,
  serializeIndexedTx,
} from './history-store'

const REF = cardanoDataRef('group-1', cardanoChainIdFor('mainnet'))
const OWN = 'addr1own'
const EXT = 'addr1ext'

const io = (addr: string, coin: bigint, tokens: {p: string; n: string; a: bigint}[] = []) => ({
  addressBech32: addr,
  coin,
  tokens: tokens.map((t) => ({policyIdHex: t.p, assetNameHex: t.n, amount: t.a})),
})

const tx = (over: Partial<IndexedCardanoTx>): IndexedCardanoTx => ({
  hash: 'abc',
  fee: 170_000n,
  inputs: [],
  outputs: [],
  networkId: 1,
  ...over,
})

describe('history-store serialization', () => {
  it('round-trips an IndexedCardanoTx incl. nested bigints', () => {
    const t = tx({
      blockHeight: 123,
      time: '2026-01-02T03:04:05Z',
      fee: 987_654n,
      inputs: [io(OWN, 5_000_000n, [{p: 'aa', n: 'beef', a: 42n}])],
      outputs: [io(EXT, 4_000_000n), io(OWN, 830_346n)],
    })
    const back = deserializeIndexedTx(serializeIndexedTx(t))
    expect(back).toEqual(t)
    expect(typeof back.fee).toBe('bigint')
    expect(back.inputs[0]?.tokens[0]?.amount).toBe(42n)
  })
})

describe('ownershipDelta', () => {
  it('classifies a send (own input, external output) with signed ADA delta', () => {
    const t = tx({inputs: [io(OWN, 10_000_000n)], outputs: [io(EXT, 6_000_000n), io(OWN, 3_830_000n)]})
    const d = ownershipDelta(t, new Set([OWN]))
    expect(d.direction).toBe('sent')
    expect(d.adaDelta).toBe(3_830_000n - 10_000_000n)
    expect(d.counterparty).toBe(EXT)
  })

  it('classifies a receive (no own input, own output)', () => {
    const t = tx({inputs: [io(EXT, 10_000_000n)], outputs: [io(OWN, 4_000_000n), io(EXT, 5_800_000n)]})
    const d = ownershipDelta(t, new Set([OWN]))
    expect(d.direction).toBe('received')
    expect(d.adaDelta).toBe(4_000_000n)
    expect(d.counterparty).toBe(EXT)
  })

  it('classifies a self tx (all own) with no counterparty', () => {
    const t = tx({inputs: [io(OWN, 10_000_000n)], outputs: [io(OWN, 9_830_000n)]})
    const d = ownershipDelta(t, new Set([OWN]))
    expect(d.direction).toBe('self')
    expect(d.counterparty).toBeNull()
  })

  it('nets multi-asset deltas and drops zero-sum tokens', () => {
    const t = tx({
      inputs: [
        io(OWN, 10_000_000n, [
          {p: 'aa', n: 'x', a: 100n},
          {p: 'bb', n: 'y', a: 5n},
        ]),
      ],
      outputs: [io(OWN, 9_800_000n, [{p: 'aa', n: 'x', a: 100n}]), io(EXT, 100_000n, [{p: 'bb', n: 'y', a: 5n}])],
    })
    const d = ownershipDelta(t, new Set([OWN]))
    // aa.x: -100 +100 = 0 (dropped); bb.y: -5 (sent out)
    expect(d.assetDeltas.get('aa.x')).toBeUndefined()
    expect(d.assetDeltas.get('bb.y')).toBe(-5n)
    expect(d.assetDeltas.size).toBe(1)
  })
})

describe('indexedTxToRow', () => {
  it('projects a confirmed send row + preserves detail for rebuild', () => {
    const t = tx({
      blockHeight: 900,
      time: '2026-03-04T00:00:00Z',
      fee: 200_000n,
      inputs: [io(OWN, 10_000_000n, [{p: 'aa', n: 'x', a: 7n}])],
      outputs: [io(EXT, 6_000_000n, [{p: 'aa', n: 'x', a: 7n}]), io(OWN, 3_800_000n)],
    })
    const row = indexedTxToRow(REF, t, new Set([OWN]))
    expect(row.hash).toBe('abc')
    expect(row.status).toBe('confirmed')
    expect(row.direction).toBe('sent')
    expect(row.amount).toBe('6200000') // |3_800_000 - 10_000_000|
    expect(row.primaryAssetDelta).toBe('-6200000')
    expect(row.fee).toBe('200000')
    expect(row.counterpartyAddress).toBe(EXT)
    expect(row.additionalAssetCount).toBe(1) // aa.x sent out
    expect(row.assetSymbol).toBe('ADA')
    expect(row.timestamp).toBe(Math.floor(Date.parse('2026-03-04T00:00:00Z') / 1000))
    expect(deserializeIndexedTx(row.detailJson ?? '')).toEqual(t)
  })

  it('marks a phase-2-invalid tx failed', () => {
    const row = indexedTxToRow(
      REF,
      tx({valid: false, inputs: [io(OWN, 5_000_000n)], outputs: [io(OWN, 1n)]}),
      new Set([OWN]),
    )
    expect(row.status).toBe('failed')
  })
})

describe('afterBlockCursor', () => {
  it('is one below the newest stored height (boundary re-included)', () => {
    expect(afterBlockCursor([tx({blockHeight: 10}), tx({blockHeight: 42}), tx({blockHeight: 7})])).toBe(41)
  })
  it('is undefined with no stored history (full initial fetch)', () => {
    expect(afterBlockCursor([])).toBeUndefined()
    expect(afterBlockCursor([tx({})])).toBeUndefined()
  })
  it('never goes below zero', () => {
    expect(afterBlockCursor([tx({blockHeight: 0})])).toBe(0)
  })
})

describe('mergeByHash', () => {
  it('keeps fresh ahead of stored and dedupes by hash', () => {
    const merged = mergeByHash([{hash: 'b'}, {hash: 'a'}], [{hash: 'a'}, {hash: 'z'}])
    expect(merged.map((m) => m.hash)).toEqual(['b', 'a', 'z'])
  })
})
