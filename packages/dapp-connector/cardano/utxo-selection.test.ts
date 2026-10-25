import {Assets} from '@evolution-sdk/evolution'
import {Effect} from 'effect'
import {describe, expect, it} from 'vitest'
import {type CardanoUtxo, parseValueTarget, selectUtxosForTarget} from './utxo-selection.js'

const utxo = (index: number, coin: bigint, assets: CardanoUtxo['assets'] = []): CardanoUtxo => ({
  txHashHex: 'aa'.repeat(32),
  index,
  addressHex: `60${'11'.repeat(28)}`,
  coin,
  assets,
})

const POLICY = 'bb'.repeat(28)
const NAME = '746f6b656e'

describe('parseValueTarget', () => {
  it('accepts a bare decimal lovelace string', async () => {
    const target = await Effect.runPromise(parseValueTarget('2500000'))
    expect(target.coin).toBe(2_500_000n)
    expect(target.assets.size).toBe(0)
  })

  it('decodes a cbor<value> with assets', async () => {
    const valueHex = Assets.toCBORHex(Assets.fromRecord({lovelace: 1_000_000n, [`${POLICY}.${NAME}`]: 7n}))
    const target = await Effect.runPromise(parseValueTarget(valueHex))
    expect(target.coin).toBe(1_000_000n)
    expect(target.assets.get(`${POLICY}.${NAME}`)).toBe(7n)
  })

  it('decodes a coin-only cbor<value>', async () => {
    const valueHex = Assets.toCBORHex(Assets.fromLovelace(42n))
    const target = await Effect.runPromise(parseValueTarget(valueHex))
    expect(target.coin).toBe(42n)
  })

  it('fails on malformed input', async () => {
    const error = await Effect.runPromise(Effect.flip(parseValueTarget('zz-not-hex')))
    expect(error._tag).toBe('CborError')
  })
})

describe('selectUtxosForTarget', () => {
  it('selects greedily in wallet order until covered', () => {
    const utxos = [utxo(0, 1_000_000n), utxo(1, 2_000_000n), utxo(2, 3_000_000n)]
    const selected = selectUtxosForTarget(utxos, {coin: 2_500_000n, assets: new Map()})
    expect(selected?.map((u) => u.index)).toEqual([0, 1])
  })

  it('returns an empty selection for a zero target', () => {
    expect(selectUtxosForTarget([utxo(0, 1n)], {coin: 0n, assets: new Map()})).toEqual([])
  })

  it('returns null when the wallet cannot cover the coin', () => {
    expect(selectUtxosForTarget([utxo(0, 1_000_000n)], {coin: 2_000_000n, assets: new Map()})).toBeNull()
  })

  it('returns null when a requested asset is missing', () => {
    const target = {coin: 0n, assets: new Map([[`${POLICY}.${NAME}`, 1n]])}
    expect(selectUtxosForTarget([utxo(0, 5_000_000n)], target)).toBeNull()
  })

  it('skips UTxOs that contribute nothing to an unmet asset need', () => {
    const target = {coin: 0n, assets: new Map([[`${POLICY}.${NAME}`, 5n]])}
    const utxos = [utxo(0, 10_000_000n), utxo(1, 1_000_000n, [{policyHex: POLICY, nameHex: NAME, quantity: 5n}])]
    const selected = selectUtxosForTarget(utxos, target)
    expect(selected?.map((u) => u.index)).toEqual([1])
  })

  it('covers coin and assets together', () => {
    const target = {coin: 3_000_000n, assets: new Map([[`${POLICY}.${NAME}`, 4n]])}
    const utxos = [
      utxo(0, 2_000_000n),
      utxo(1, 2_000_000n, [{policyHex: POLICY, nameHex: NAME, quantity: 3n}]),
      utxo(2, 1_000_000n, [{policyHex: POLICY, nameHex: NAME, quantity: 2n}]),
    ]
    const selected = selectUtxosForTarget(utxos, target)
    expect(selected?.map((u) => u.index)).toEqual([0, 1, 2])
  })
})
