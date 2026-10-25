import type {Assets as EvAssets, UTxO} from '@evolution-sdk/evolution'
import {Address as EvAddress, MinAda, TxOut, Value} from '@evolution-sdk/evolution'
import {AddressHex} from '@evolution-sdk/review/Brands'
import * as Inspect from '@evolution-sdk/review/Inspect'
import {Effect} from 'effect'
import {beforeAll, describe, expect, it} from 'vitest'
import type {CardanoRail} from '../rail'
import {changeValueHex} from '../send-flow'
import {testUtxo} from '../test-utxo'
import {consolidationAssetOutputs, consolidationSignerCount, foldConsolidationLegs} from './build'
import {DEFAULT_WALLET_OPTIMIZATION, type WalletOptimization} from './policy'

const POLICY_A = 'aa'.repeat(28)
const POLICY_B = 'bb'.repeat(28)
const ADDRESS_HEX = `01${'11'.repeat(28)}${'22'.repeat(28)}`

// Mainnet epoch 645, the same figures the size model was measured against.
const PARAMS = {
  minFeeA: 44n,
  minFeeB: 155_381n,
  coinsPerUtxoByte: 4310n,
  keyDeposit: 2_000_000n,
  poolDeposit: 500_000_000n,
  drepDeposit: 500_000_000n,
  maxValueSize: 5000n,
  maxTxSize: 16_384n,
}

let rail: CardanoRail

beforeAll(() => {
  rail = {account: {addressHex: ADDRESS_HEX}} as unknown as CardanoRail
})

const utxo = (
  fill: number,
  lovelace: bigint,
  assets?: ReadonlyMap<string, bigint>,
  address = 'addr_test1qq8ac7qqy0vtulyl7wntmsxc6wex80gvcyjy33qffrhm7s5x7x4e49fkw9ydmrzsjdek5v45cyh5qqs8hsm9l2vcyutsszhdem',
): UTxO.UTxO => testUtxo({txHash: fill, address, lovelace, ...(assets !== undefined ? {assets} : {})})

const policy = (patch: Partial<WalletOptimization> = {}): WalletOptimization => ({
  ...DEFAULT_WALLET_OPTIMIZATION,
  ...patch,
})

/**
 * `count` assets under one policy, each with a distinct name of exactly 32 bytes
 * — the ledger's maximum, and the widest an asset name can legally be.
 */
const manyAssets = (count: number, policyId: string): ReadonlyMap<string, bigint> =>
  new Map(Array.from({length: count}, (_, i) => [`${policyId}.${i.toString(16).padStart(4, '0').repeat(16)}`, 1n]))

describe('consolidationSignerCount', () => {
  it('counts one witness per distinct input address', () => {
    const inputs = [
      utxo(
        1,
        1n,
        undefined,
        'addr_test1qp8wl3hnya9l94rt58ky533deyqe9t8zz5n9su26k8e5g23yar4q0adtaax9q9g0kphpv2ws7vxqwu6ln6pqx7j29nfqnle9hh',
      ),
      utxo(
        2,
        1n,
        undefined,
        'addr_test1qpu5vlrf4xkxv2qpwngf6cjhtw542ayty80v8dyr49rf5ewvxwdrt70qlcpeeagscasafhffqsxy36t90ldv06wqrk2qum8x5w',
      ),
      utxo(
        3,
        1n,
        undefined,
        'addr_test1qp8wl3hnya9l94rt58ky533deyqe9t8zz5n9su26k8e5g23yar4q0adtaax9q9g0kphpv2ws7vxqwu6ln6pqx7j29nfqnle9hh',
      ),
    ]
    expect(consolidationSignerCount(inputs, false)).toBe(2)
  })

  it('adds the stake key when rewards are withdrawn in the same transaction', () => {
    expect(
      consolidationSignerCount(
        [
          utxo(
            1,
            1n,
            undefined,
            'addr_test1qp8wl3hnya9l94rt58ky533deyqe9t8zz5n9su26k8e5g23yar4q0adtaax9q9g0kphpv2ws7vxqwu6ln6pqx7j29nfqnle9hh',
          ),
        ],
        true,
      ),
    ).toBe(2)
  })

  it('never sizes for zero witnesses', () => {
    // An empty probe still needs one dummy witness, or the fee is sized for a
    // transaction nobody can sign.
    expect(consolidationSignerCount([], false)).toBe(1)
  })
})

describe('consolidationAssetOutputs', () => {
  it('emits nothing for a pure-ADA fold — change carries all of it', () => {
    const inputs = [utxo(1, 5_000_000n), utxo(2, 3_000_000n)]
    expect(consolidationAssetOutputs(rail, PARAMS, inputs, policy())).toEqual([])
  })

  it('lets the only asset group ride in change rather than paying for an output', () => {
    const inputs = [utxo(1, 5_000_000n, new Map([[`${POLICY_A}.01`, 7n]]))]
    expect(consolidationAssetOutputs(rail, PARAMS, inputs, policy())).toEqual([])
  })

  it('emits an explicit output for every group past the first, each inside the value bound', () => {
    // 400 assets ≈ 14 KB of value against a 5 KB bound, so this must split.
    const inputs = [utxo(1, 500_000_000n, manyAssets(400, POLICY_A))]
    const outputs = consolidationAssetOutputs(rail, PARAMS, inputs, policy())

    expect(outputs.length).toBeGreaterThan(0)
    for (const out of outputs) {
      expect(out.addressHex).toBe(ADDRESS_HEX)
      // The bound is on the serialized VALUE, which is what the ledger measures.
      expect(BigInt(Value.toCBORBytes(Value.fromCBORHex(changeValueHex(out.assets))).length)).toBeLessThanOrEqual(
        PARAMS.maxValueSize,
      )
    }
  })

  it('carries exactly the min-ADA floor on each packed output', async () => {
    const inputs = [utxo(1, 500_000_000n, manyAssets(400, POLICY_A))]
    const outputs = consolidationAssetOutputs(rail, PARAMS, inputs, policy())
    expect(outputs.length).toBeGreaterThan(0)

    for (const out of outputs) {
      const value = await Effect.runPromise(Inspect.value(changeValueHex(out.assets)))
      // ⚠️ `encodingFormat: 'babbage'`, the shape the consolidation emits — a floor measured in
      // the Shelley shape is the wrong floor for it.
      const floor = MinAda.forOutput(
        new TxOut.TransactionOutput({
          address: EvAddress.fromHex(AddressHex(ADDRESS_HEX)),
          assets: out.assets,
          encodingFormat: 'babbage',
        }),
        PARAMS.coinsPerUtxoByte,
      )
      // Exactly the floor: anything above it is ADA locked out of the next send.
      expect(value.amount).toBe(floor)
    }
  })

  it('accounts for every asset it was given, across all outputs plus the one riding in change', async () => {
    const held = manyAssets(400, POLICY_A)
    const outputs = consolidationAssetOutputs(rail, PARAMS, [utxo(1, 500_000_000n, held)], policy())

    const placed = new Set<string>()
    for (const out of outputs) {
      const value = await Effect.runPromise(Inspect.value(changeValueHex(out.assets)))
      for (const token of value.tokens) placed.add(`${token.policyIdHex}.${token.assetNameHex}`)
    }
    // The first group is deliberately absent — it rides in change — so the
    // explicit outputs must cover everything else and nothing twice.
    expect(placed.size).toBeLessThan(held.size)
    for (const id of placed) expect(held.has(id)).toBe(true)
  })

  /**
   * ⚠️ **The "mixes them when not" half of this claim is gone, and the TYPE removed it.**
   *
   * It used to interleave two policies' assets on the way in — `a[0], b[0], a[1], b[1], …` — so
   * that only the bundling sort could co-locate them, and asserted that without bundling every
   * output carried both. A `UTxO` holds Evolution's `Assets`, whose `MultiAsset` is keyed BY
   * POLICY, so an interleaved insertion order does not survive construction: the bag reads back
   * grouped (`aa… aa… aa… bb… bb… bb…`), verified directly. The premise is unreachable through a
   * UTxO, so what is left to assert is the half that still means something — bundling leaves at
   * most one straddling group.
   */
  it('keeps each policy in its own output when bundling', async () => {
    const interleaved = new Map<string, bigint>([...manyAssets(300, POLICY_A), ...manyAssets(300, POLICY_B)])
    const inputs = [utxo(1, 2_000_000_000n, interleaved)]

    const policiesPerOutput = async (outputs: readonly {readonly assets: EvAssets.Assets}[]) =>
      Promise.all(
        outputs.map(async (out) => {
          const value = await Effect.runPromise(Inspect.value(changeValueHex(out.assets)))
          return new Set(value.tokens.map((token) => token.policyIdHex)).size
        }),
      )

    const bundled = await policiesPerOutput(
      consolidationAssetOutputs(rail, PARAMS, inputs, policy({bundleByPolicy: true})),
    )
    // Bundling leaves at most one straddling group — the boundary between the two policies.
    expect(bundled.filter((n) => n > 1).length).toBeLessThanOrEqual(1)
    // Every output carries at least one policy's worth, and none is empty.
    expect(bundled.every((n) => n >= 1)).toBe(true)
  })

  it('performs no packing when the protocol reports no value bound', () => {
    const {maxValueSize: _dropped, ...noBound} = PARAMS
    const inputs = [utxo(1, 500_000_000n, manyAssets(400, POLICY_A))]
    expect(consolidationAssetOutputs(rail, noBound, inputs, policy())).toEqual([])
  })
})

describe('foldConsolidationLegs', () => {
  const utxos = (n: number) => Array.from({length: n}, (_, i) => utxo(i + 1, 5_000_000n))

  /** A leg builder that always takes `take` inputs and produces one output. */
  const takes = (take: number, calls: {remaining: number; isFirst: boolean}[] = []) => ({
    calls,
    build: (remaining: readonly UTxO.UTxO[], isFirst: boolean) => {
      calls.push({remaining: remaining.length, isFirst})
      return Effect.succeed({inputCount: Math.min(take, remaining.length), outputCount: 1})
    },
  })

  it('folds the whole set when each leg swallows a slice', async () => {
    const {build, calls} = takes(4)
    const result = await Effect.runPromise(foldConsolidationLegs(utxos(10), 5, build))

    expect(result.legs.map((l) => l.inputCount)).toEqual([4, 4, 2])
    expect(result.remaining).toEqual([])
    expect(result.stop).toBe('complete')
    expect(calls.map((c) => c.remaining)).toEqual([10, 6, 2])
  })

  it('marks only the first call as first, so rewards are withdrawn once', async () => {
    const {build, calls} = takes(3)
    await Effect.runPromise(foldConsolidationLegs(utxos(9), 5, build))

    expect(calls.map((c) => c.isFirst)).toEqual([true, false, false])
  })

  it('stops at the leg cap and reports what is left rather than dropping it', async () => {
    const {build} = takes(2)
    const result = await Effect.runPromise(foldConsolidationLegs(utxos(20), 3, build))

    expect(result.legs).toHaveLength(3)
    expect(result.remaining).toHaveLength(14)
  })

  it('leaves a lone trailing UTxO alone — one input is not a fold', async () => {
    const {build} = takes(4)
    const result = await Effect.runPromise(foldConsolidationLegs(utxos(9), 5, build))

    expect(result.legs.map((l) => l.inputCount)).toEqual([4, 4])
    expect(result.remaining).toHaveLength(1)
  })

  it('refuses a leg that would not reduce the set, and stops there', async () => {
    // Two inputs in, two outputs out: a fee for nothing.
    let calls = 0
    const build = () => {
      calls++
      return Effect.succeed({inputCount: 2, outputCount: 2})
    }
    const result = await Effect.runPromise(foldConsolidationLegs(utxos(10), 5, build))

    expect(result.legs).toEqual([])
    expect(result.remaining).toHaveLength(10)
    // Stopped rather than walking the rest of the list: later candidates only
    // make a leg bigger, so retrying cannot help.
    expect(calls).toBe(1)
  })

  it('never builds for a set too small to fold', async () => {
    let calls = 0
    const build = () => {
      calls++
      return Effect.succeed({inputCount: 1, outputCount: 1})
    }
    const result = await Effect.runPromise(foldConsolidationLegs(utxos(1), 5, build))

    expect(calls).toBe(0)
    expect(result.legs).toEqual([])
    expect(result.remaining).toHaveLength(1)
  })

  it('propagates a build failure instead of returning the legs before it', async () => {
    const outcome = await Effect.runPromise(
      Effect.either(foldConsolidationLegs(utxos(6), 5, () => Effect.fail('build blew up'))),
    )
    expect(outcome._tag).toBe('Left')
  })
})
