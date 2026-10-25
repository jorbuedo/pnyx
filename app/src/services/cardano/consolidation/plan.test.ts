import type {UTxO} from '@evolution-sdk/evolution'
import {describe, expect, it} from 'vitest'
import {testUtxo} from '../test-utxo'
import {utxoTxHashHex} from '../utxo-view'
import {
  isPureAda,
  orderAssetsForPacking,
  reducesUtxoCount,
  selectConsolidationCandidates,
  totalAssets,
  totalLovelace,
} from './plan'
import {DEFAULT_WALLET_OPTIMIZATION, type WalletOptimization} from './policy'

const POLICY_A = 'aa'.repeat(28)
const POLICY_B = 'bb'.repeat(28)

const utxo = (fill: number, lovelace: bigint, assets?: ReadonlyMap<string, bigint>): UTxO.UTxO =>
  testUtxo({txHash: fill, lovelace, ...(assets !== undefined ? {assets} : {})})

const policy = (patch: Partial<WalletOptimization> = {}): WalletOptimization => ({
  ...DEFAULT_WALLET_OPTIMIZATION,
  ...patch,
})

describe('isPureAda', () => {
  it('is true for a token-free UTxO', () => {
    expect(isPureAda(utxo(0x01, 5_000_000n))).toBe(true)
    // An empty asset map counts as pure — it is the same UTxO either way.
    expect(isPureAda(utxo(0x01, 5_000_000n, new Map()))).toBe(true)
  })

  it('is false once it carries an asset', () => {
    expect(isPureAda(utxo(0x01, 5_000_000n, new Map([[`${POLICY_A}.01`, 1n]])))).toBe(false)
  })
})

describe('totalAssets', () => {
  it('sums the same asset across UTxOs', () => {
    const id = `${POLICY_A}.01`
    const totals = totalAssets([utxo(0x01, 1n, new Map([[id, 3n]])), utxo(0x02, 1n, new Map([[id, 4n]]))])

    expect(totals).toEqual([{assetId: id, amount: 7n}])
  })

  it('is empty for pure-ADA UTxOs', () => {
    expect(totalAssets([utxo(0x01, 5n), utxo(0x02, 6n)])).toEqual([])
  })
})

describe('totalLovelace', () => {
  it('sums lovelace', () => {
    expect(totalLovelace([utxo(0x01, 5n), utxo(0x02, 6n)])).toBe(11n)
  })
})

describe('orderAssetsForPacking', () => {
  it('groups assets of the same policy together', () => {
    // Interleaved on the way in; adjacency is what lets the packer fill densely.
    const assets = [
      {assetId: `${POLICY_B}.01`, amount: 1n},
      {assetId: `${POLICY_A}.01`, amount: 1n},
      {assetId: `${POLICY_B}.02`, amount: 1n},
      {assetId: `${POLICY_A}.02`, amount: 1n},
    ]

    const ordered = orderAssetsForPacking(assets, policy({bundleByPolicy: true}))
    const policies = ordered.map((a) => a.assetId.split('.')[0])

    expect(policies).toEqual([POLICY_A, POLICY_A, POLICY_B, POLICY_B])
  })

  it('preserves the given order when bundling is off', () => {
    const assets = [
      {assetId: `${POLICY_B}.01`, amount: 1n},
      {assetId: `${POLICY_A}.01`, amount: 1n},
    ]

    expect(orderAssetsForPacking(assets, policy({bundleByPolicy: false}))).toEqual(assets)
  })
})

describe('selectConsolidationCandidates', () => {
  it('offers pure-ADA UTxOs first — they are the densest inputs', () => {
    const withAsset = utxo(0x0a, 2_000_000n, new Map([[`${POLICY_A}.01`, 1n]]))
    const pure1 = utxo(0x01, 5_000_000n)
    const pure2 = utxo(0x02, 4_000_000n)

    const {candidates} = selectConsolidationCandidates([withAsset, pure1, pure2], policy({keepPureAdaOutput: false}))

    expect(candidates.map((u) => utxoTxHashHex(u).slice(0, 2))).toEqual(['01', '02', '0a'])
  })

  it('reserves the largest pure-ADA UTxO when keepPureAdaOutput is on', () => {
    const small = utxo(0x01, 2_000_000n)
    const large = utxo(0x02, 9_000_000n)

    const {candidates, excluded} = selectConsolidationCandidates([small, large], policy())

    // The biggest is held back: it is the most useful cheap input to keep, and
    // reserving the smallest would leave dust behind instead.
    expect(candidates.map((u) => utxoTxHashHex(u).slice(0, 2))).toEqual(['01'])
    expect(excluded).toEqual([{utxo: large, reason: 'reserved-pure-ada'}])
  })

  it('reserves nothing when there is no pure-ADA UTxO to reserve', () => {
    const a = utxo(0x01, 2_000_000n, new Map([[`${POLICY_A}.01`, 1n]]))
    const b = utxo(0x02, 2_000_000n, new Map([[`${POLICY_A}.02`, 1n]]))

    const {candidates, excluded} = selectConsolidationCandidates([a, b], policy())

    expect(candidates).toHaveLength(2)
    expect(excluded).toEqual([])
  })

  it('honours the input cap and reports what it left out', () => {
    const utxos = [utxo(0x01, 1n), utxo(0x02, 2n), utxo(0x03, 3n), utxo(0x04, 4n)]

    const {candidates, excluded} = selectConsolidationCandidates(
      utxos,
      policy({keepPureAdaOutput: false, maxInputsPerTx: 2}),
    )

    expect(candidates).toHaveLength(2)
    expect(excluded).toHaveLength(2)
    expect(excluded.every((e) => e.reason === 'over-input-cap')).toBe(true)
  })

  it('never silently drops a UTxO — candidates plus excluded is the whole set', () => {
    const utxos = [
      utxo(0x01, 5_000_000n),
      utxo(0x02, 4_000_000n),
      utxo(0x03, 2_000_000n, new Map([[`${POLICY_A}.01`, 1n]])),
      utxo(0x04, 1_000_000n),
    ]

    const {candidates, excluded} = selectConsolidationCandidates(utxos, policy({maxInputsPerTx: 2}))

    expect(candidates.length + excluded.length).toBe(utxos.length)
  })
})

describe('reducesUtxoCount', () => {
  it('needs at least two inputs to be worth a fee', () => {
    expect(reducesUtxoCount(1, 1)).toBe(false)
  })

  it('is false when it would produce as many outputs as it consumes', () => {
    // A wallet whose assets span enough policies that every output fills up gets
    // no benefit — and must not be charged a fee for none.
    expect(reducesUtxoCount(5, 5)).toBe(false)
    expect(reducesUtxoCount(5, 6)).toBe(false)
  })

  it('is true when the set actually shrinks', () => {
    expect(reducesUtxoCount(10, 2)).toBe(true)
  })
})
