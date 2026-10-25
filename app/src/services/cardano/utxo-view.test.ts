import {Assets as EvAssets, Address as EvolutionAddress, TransactionHash, UTxO} from '@evolution-sdk/evolution'
import {Bech32} from '@evolution-sdk/review/Brands'
import {Address} from '@pnyx/cardano-core'
import {Effect} from 'effect'
import {describe, expect, it} from 'vitest'
import {utxoAddressBech32, utxoAssetMap, utxoIsAdaOnly, utxoTokenCount, utxoTxHashHex} from './utxo-view'

const ADDR =
  'addr_test1qp8wl3hnya9l94rt58ky533deyqe9t8zz5n9su26k8e5g23yar4q0adtaax9q9g0kphpv2ws7vxqwu6ln6pqx7j29nfqnle9hh'
const POLICY = 'aa'.repeat(28)

const utxo = (assets: EvAssets.Assets): UTxO.UTxO =>
  new UTxO.UTxO({
    transactionId: TransactionHash.fromHex('bb'.repeat(32)),
    index: 3n,
    address: EvolutionAddress.fromBech32(ADDR),
    assets,
  })

describe('utxoAssetMap', () => {
  it('spells a unit `policy.name`, with a dot', () => {
    const map = utxoAssetMap(utxo(EvAssets.addByHex(EvAssets.fromLovelace(2_000_000n), POLICY, '4e4654', 5n)))
    // ⚠️ The whole point of the module. Evolution's own `getUnits` answers the JOINED form, and
    // every stored row and intent in this app is keyed on the dotted one — both `string`, so a
    // mismatch answers `0n` instead of failing.
    expect([...map.keys()]).toEqual([`${POLICY}.4e4654`])
    expect(map.get(`${POLICY}.4e4654`)).toBe(5n)
    expect(map.get(`${POLICY}4e4654`)).toBeUndefined()
  })

  it('keeps an EMPTY asset name, which is a real name rather than a missing one', () => {
    const map = utxoAssetMap(utxo(EvAssets.addByHex(EvAssets.fromLovelace(2_000_000n), POLICY, '', 7n)))
    expect(map.get(`${POLICY}.`)).toBe(7n)
  })

  it('is empty for a lovelace-only UTxO rather than absent', () => {
    expect(utxoAssetMap(utxo(EvAssets.fromLovelace(1_000_000n))).size).toBe(0)
  })
})

describe('utxoIsAdaOnly / utxoTokenCount', () => {
  it('separates a lovelace-only UTxO from one holding a token', () => {
    const withToken = EvAssets.addByHex(EvAssets.fromLovelace(2_000_000n), POLICY, '4e4654', 5n)
    expect(utxoIsAdaOnly(utxo(EvAssets.fromLovelace(2_000_000n)))).toBe(true)
    expect(utxoTokenCount(utxo(EvAssets.fromLovelace(2_000_000n)))).toBe(0)
    expect(utxoIsAdaOnly(utxo(withToken))).toBe(false)
    expect(utxoTokenCount(utxo(withToken))).toBe(1)
  })

  it('⚠️ cannot hold a zero-quantity token at all, which is why the `hasMultiAsset` trap is gone', () => {
    // A bag CAN hold a zero after a subtract, and `Assets.hasMultiAsset` answers true for it —
    // the trap that once made a spent-out token read as a token. Evolution's `UTxO` carries an
    // `allPositive` filter, so such a bag cannot be inside one: the constructor refuses it.
    // That is a property of the type, not of these helpers, and it is why they can use either
    // predicate safely. `hasOnlyLovelace` is still the one that states the question.
    const withToken = EvAssets.addByHex(EvAssets.fromLovelace(2_000_000n), POLICY, '4e4654', 5n)
    const zeroed = EvAssets.subtract(withToken, EvAssets.addByHex(EvAssets.fromLovelace(0n), POLICY, '4e4654', 5n))
    expect(() => utxo(zeroed)).toThrow(/positive token quantities/)
  })
})

describe('utxoAddressBech32 / utxoTxHashHex', () => {
  it('round-trips the address the UTxO arrived with', async () => {
    expect(utxoAddressBech32(utxo(EvAssets.fromLovelace(1n)))).toBe(ADDR)
    // The same bytes the rest of the app keys on, reached the production way.
    expect(
      await Effect.runPromise(Address.fromBech32(Bech32(utxoAddressBech32(utxo(EvAssets.fromLovelace(1n)))))),
    ).toBe(Address.fromBech32Sync(Bech32(ADDR)))
  })

  it('answers a lowercase 64-char hash, because the id string is persisted', () => {
    const hex = utxoTxHashHex(utxo(EvAssets.fromLovelace(1n)))
    expect(hex).toBe('bb'.repeat(32))
    expect(hex).toBe(hex.toLowerCase())
  })
})
