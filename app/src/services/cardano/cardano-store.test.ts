import type {UTxO} from '@evolution-sdk/evolution'
import {CARDANO_MAINNET} from '@pnyx/config'
import {describe, expect, it} from 'vitest'
import {buildCardanoSnapshot, cardanoDataRef, rowToUtxo, snapshotBalancesOf, utxoToRow} from './cardano-store'
import {testUtxo} from './test-utxo'
import {utxoAssetMap} from './utxo-view'

const ref = cardanoDataRef('group-1', CARDANO_MAINNET, 0)

// ⚠️ Real policy ids and asset names. The old fixture used `0691b2fe.4e49474854` — a 4-byte
// "policy", which no chain produces and which Evolution's `Assets` refuses.
const POLICY_A = 'a0'.repeat(28)
const POLICY_B = 'b1'.repeat(28)

const withAssets: UTxO.UTxO = testUtxo({
  txHash: 'abcdef01',
  index: 2,
  lovelace: 1_698_140n,
  assets: new Map([
    [`${POLICY_A}.4e49474854`, 39_691_352_407n],
    [`${POLICY_B}.deadbeef`, 42n],
  ]),
})

const pureAda: UTxO.UTxO = testUtxo({txHash: '001122', lovelace: 5_000_000n})

describe('cardano-store row mappers', () => {
  it('round-trips a multi-asset UTxO UTxO.UTxO → row → UTxO.UTxO', () => {
    expect(rowToUtxo(utxoToRow(ref, withAssets))).toEqual(withAssets)
  })

  it('round-trips a pure-ADA UTxO (no assets map)', () => {
    const back = rowToUtxo(utxoToRow(ref, pureAda))
    expect(back).toEqual(pureAda)
    // ⚠️ An empty bag rather than an absent map. `hasOnlyLovelace` is the question, and the type
    // cannot hold a zero-quantity token at all, so there is no "absent vs empty" to tell apart.
    expect(utxoAssetMap(back).size).toBe(0)
  })

  it('encodes the row with the ref, hex txHash, and decimal quantities', () => {
    const row = utxoToRow(ref, withAssets)
    expect(row.groupId).toBe('group-1')
    expect(row.chainId).toBe(CARDANO_MAINNET)
    expect(row.txHash).toBe('abcdef01'.padEnd(64, '0'))
    expect(row.quantity).toBe('1698140')
    expect(row.assets).toEqual([
      {id: `${POLICY_A}.4e49474854`, quantity: '39691352407'},
      {id: `${POLICY_B}.deadbeef`, quantity: '42'},
    ])
  })
})

describe('snapshotBalancesOf', () => {
  it('sums lovelace and per-asset quantities across UTxOs', () => {
    const balances = snapshotBalancesOf([withAssets, pureAda])
    expect(balances.primary).toEqual({id: '.', quantity: '6698140'})
    expect(balances.secondary).toEqual([
      {id: `${POLICY_A}.4e49474854`, quantity: '39691352407'},
      {id: `${POLICY_B}.deadbeef`, quantity: '42'},
    ])
  })

  it('is empty for no UTxOs', () => {
    expect(snapshotBalancesOf([])).toEqual({primary: {id: '.', quantity: '0'}, secondary: []})
  })
})

describe('buildCardanoSnapshot', () => {
  it('carries the watermark when present', () => {
    const wm = {newestTxHash: 'aa', newestBlockHeight: 123}
    const snap = buildCardanoSnapshot(ref, [pureAda], wm, 'cov-1')
    expect(snap.groupId).toBe('group-1')
    expect(snap.chainId).toBe(CARDANO_MAINNET)
    expect(snap.accountIndex).toBe(0)
    expect(snap.syncWatermark).toEqual(wm)
    expect(snap.balances.primary.quantity).toBe('5000000')
  })

  it('omits the watermark when null (first sync, unprobed)', () => {
    expect(buildCardanoSnapshot(ref, [pureAda], null, 'cov-1').syncWatermark).toBeUndefined()
  })

  // A watermark asserts "fetched up to here" for the addresses that produced it. Stored
  // without that set, the next rail cannot tell whether it speaks for its own addresses —
  // which is how a wider rail trusted a primary-only rail's watermark and never fetched.
  it('records the coverage that produced the watermark, so a wider rail can reject it', () => {
    expect(buildCardanoSnapshot(ref, [pureAda], {newestTxHash: 'aa', newestBlockHeight: 1}, 'cov-1').syncCoverage).toBe(
      'cov-1',
    )
  })

  it('writes no coverage without a watermark, since neither is usable alone', () => {
    expect(buildCardanoSnapshot(ref, [pureAda], null, 'cov-1').syncCoverage).toBeUndefined()
  })
})
