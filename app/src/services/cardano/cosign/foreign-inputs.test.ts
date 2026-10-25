import {
  Assets,
  Bytes,
  Address as EvAddress,
  Address as EvolutionAddress,
  Assets as EvolutionAssets,
  UTxO as EvolutionUTxO,
  TransactionBody,
  TransactionHash,
  TxOut,
} from '@evolution-sdk/evolution'
import {Bech32, TxHashHex} from '@evolution-sdk/review/Brands'
import {type Decode, layer as EvolutionDecodeLayer} from '@evolution-sdk/review/Decode'
import {Address, Tx} from '@pnyx/cardano-core'
import type {ResolvedInput} from '@pnyx/tx-review'
import {Effect} from 'effect'
import {beforeAll, describe, expect, it} from 'vitest'
import type {CardanoRail} from '../rail'
import {
  mergeResolvedInputs,
  missingOutpointsOf,
  type Outpoint,
  resolveInputsWithChain,
  spentInputCountOf,
} from './foreign-inputs'

const HASH_A = 'aa'.repeat(32)
const HASH_B = 'bb'.repeat(32)

const resolved = (txHashHex: string, index: number, coin = 1_000_000n): ResolvedInput => ({
  txHashHex,
  index,
  addressHex: '00'.repeat(29),
  coin,
  tokens: [],
})

const ref = (txHash: string, index: number): Outpoint => ({txHash: TxHashHex(txHash), index})

describe('missingOutpointsOf', () => {
  it('asks for nothing when the wallet already holds every input', () => {
    expect(missingOutpointsOf([ref(HASH_A, 0), ref(HASH_B, 1)], [resolved(HASH_A, 0), resolved(HASH_B, 1)])).toEqual([])
  })

  it('returns only the inputs the wallet does not hold', () => {
    expect(missingOutpointsOf([ref(HASH_A, 0), ref(HASH_B, 1)], [resolved(HASH_A, 0)])).toEqual([ref(HASH_B, 1)])
  })

  // The body and the UTxO set need not agree on hex case, and a case-sensitive compare
  // makes every input look foreign — which is a full indexer round trip on every review
  // of an ordinary send, where nothing was missing at all.
  it('matches irrespective of hex case', () => {
    expect(missingOutpointsOf([ref(HASH_A.toUpperCase(), 0)], [resolved(HASH_A, 0)])).toEqual([])
  })

  // Same transaction, different output: two distinct coins that happen to share a hash.
  it('distinguishes outputs of one transaction by index', () => {
    expect(missingOutpointsOf([ref(HASH_A, 0), ref(HASH_A, 1)], [resolved(HASH_A, 0)])).toEqual([ref(HASH_A, 1)])
  })

  it('asks for a repeated outpoint once', () => {
    expect(missingOutpointsOf([ref(HASH_A, 0), ref(HASH_A, 0)], [])).toEqual([ref(HASH_A, 0)])
  })
})

describe('mergeResolvedInputs', () => {
  it('keeps both sides when they describe different coins', () => {
    const merged = mergeResolvedInputs([resolved(HASH_A, 0)], [resolved(HASH_B, 1)])
    expect(merged.map((i) => `${i.txHashHex}#${i.index}`)).toEqual([`${HASH_A}#0`, `${HASH_B}#1`])
  })

  /**
   * The trust rule, as arithmetic.
   *
   * The fetched entry is the indexer's answer and the own entry is the wallet's own view of
   * its own coin. They should agree; if they ever do not, the review must state what the
   * wallet knows first-hand rather than what something else said about it.
   */
  it('prefers the wallet own entry over a fetched one for the same coin', () => {
    const merged = mergeResolvedInputs([resolved(HASH_A, 0, 5_000_000n)], [resolved(HASH_A, 0, 9_999_999n)])
    expect(merged).toHaveLength(1)
    expect(merged[0]?.coin).toBe(5_000_000n)
  })

  it('returns the wallet own set unchanged when nothing was fetched', () => {
    const own = [resolved(HASH_A, 0)]
    expect(mergeResolvedInputs(own, [])).toEqual(own)
  })
})

/**
 * The two chain reads, over a typed client.
 *
 * ⚠️ Both go through `resolveOutRefs` rather than `getUtxosByOutRef`, and the difference IS the
 * behaviour: the latter filters a consumed output away and carries no spent flag, so the count
 * over it is always zero and the resolution over it loses exactly the inputs a co-signer needs
 * to be told about. The stub answers both reads off one row set, so the assertions below
 * distinguish the two contracts rather than the two fixtures.
 */
describe('reading a co-signed body from the chain', () => {
  const ADDRESS =
    'addr_test1qp8wl3hnya9l94rt58ky533deyqe9t8zz5n9su26k8e5g23yar4q0adtaax9q9g0kphpv2ws7vxqwu6ln6pqx7j29nfqnle9hh'

  let bodyHex: string

  beforeAll(() => {
    // A real body, so the inputs come out of CBOR the way production reads them. Synchronous:
    // building one needs no service now, where it used to need a `Codec` from the context.
    const addr = Address.fromBech32Sync(Bech32(ADDRESS))
    bodyHex = TransactionBody.toCBORHex(
      TransactionBody.fromEncoded({
        inputs: [Bytes.fromHex(Tx.inputHex(TxHashHex(HASH_A), 0n)), Bytes.fromHex(Tx.inputHex(TxHashHex(HASH_B), 1n))],
        outputs: [
          TxOut.toCBORBytes(
            new TxOut.TransactionOutput({
              address: EvAddress.fromHex(addr),
              assets: Assets.fromLovelace(1_000_000n),
              encodingFormat: 'babbage',
            }),
          ),
        ],
        fee: 200_000n,
      }),
    )
  })

  const row = (txHash: string, index: bigint, lovelace: bigint) =>
    new EvolutionUTxO.UTxO({
      transactionId: TransactionHash.fromHex(txHash),
      index,
      address: EvolutionAddress.fromBech32(ADDRESS),
      assets: EvolutionAssets.fromLovelace(lovelace),
    })

  const LIVE = {utxo: row(HASH_A, 0n, 2_000_000n), spent: false}
  const GONE = {utxo: row(HASH_B, 1n, 3_000_000n), spent: true}

  /**
   * A rail whose chain client answers both outpoint reads off one row set.
   *
   * `served: false` is a backend with no `resolveOutRefs` — the filtered read only.
   */
  const railWith = (rows: readonly {utxo: EvolutionUTxO.UTxO; spent: boolean}[], served = true) =>
    ({
      chain: {
        ...(served ? {resolveOutRefs: () => Effect.succeed(rows.map((r) => ({...r})))} : {}),
        getUtxosByOutRef: () => Effect.succeed(rows.filter((r) => !r.spent).map((r) => r.utxo)),
      },
    }) as unknown as CardanoRail

  const run = <A>(eff: Effect.Effect<A, never, Decode>): Promise<A> =>
    Effect.runPromise(eff.pipe(Effect.provide(EvolutionDecodeLayer)))

  it('counts the inputs the chain says are gone', async () => {
    expect(await run(spentInputCountOf(railWith([LIVE, GONE]), bodyHex))).toBe(1)
  })

  it('counts an unflagged row as NOT spent, because undefined is unknown', async () => {
    const unflagged = [
      {utxo: LIVE.utxo, spent: undefined},
      {utxo: GONE.utxo, spent: undefined},
    ] as never
    expect(await run(spentInputCountOf(railWith(unflagged), bodyHex))).toBe(0)
  })

  it('answers 0 rather than guessing when the backend cannot resolve a spent outpoint', async () => {
    // The pre-existing state: "we do not know" reads as "nothing is spent", which leaves the
    // transaction alone instead of declaring it dead.
    expect(await run(spentInputCountOf(railWith([LIVE, GONE], false), bodyHex))).toBe(0)
  })

  it('resolves a SPENT input too, so a review of a dead transaction still states its amounts', async () => {
    const inputs = await run(resolveInputsWithChain(railWith([LIVE, GONE]), bodyHex, []))

    expect(inputs.map((i) => [i.txHashHex, i.coin])).toEqual([
      [HASH_A, 2_000_000n],
      [HASH_B, 3_000_000n],
    ])
    // The address arrives decoded, so there is no bech32 round trip and no failure path left.
    expect(inputs[0]?.addressBech32).toBe(ADDRESS)
    expect(inputs[0]?.addressHex).toHaveLength(114)
  })

  it('loses the spent input on a backend without the member, which is the fallback it is', async () => {
    const inputs = await run(resolveInputsWithChain(railWith([LIVE, GONE], false), bodyHex, []))
    expect(inputs.map((i) => i.txHashHex)).toEqual([HASH_A])
  })
})
