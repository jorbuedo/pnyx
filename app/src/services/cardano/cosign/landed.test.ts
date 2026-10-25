import {
  Assets,
  Bytes,
  Address as EvAddress,
  Address as EvolutionAddress,
  Assets as EvolutionAssets,
  Provider as EvolutionProvider,
  UTxO as EvolutionUTxO,
  TransactionBody,
  TransactionHash,
  TxOut,
} from '@evolution-sdk/evolution'
import {Bech32, TxHashHex} from '@evolution-sdk/review/Brands'
import {layer as EvolutionDecodeLayer} from '@evolution-sdk/review/Decode'
import {Address, Tx} from '@pnyx/cardano-core'
import {Effect} from 'effect'
import {beforeAll, describe, expect, it} from 'vitest'
import type {CardanoRail} from '../rail'
import {chainVerdict, envelopeChainState} from './landed'

const TX_HASH = 'ab'.repeat(32)

describe('chainVerdict', () => {
  it('is open while the inputs are still unspent', () => {
    expect(chainVerdict({spentInputs: 0, txHash: TX_HASH, producedOutputs: null})).toEqual({kind: 'open'})
  })

  it('reports our own landed transaction as landed, not as one to rebuild', () => {
    // The regression this exists for. Both outcomes arrive here with inputs spent, and only
    // this one means the transaction succeeded. Collapsing them told the person who *built* a
    // transaction that had just landed on chain that "whoever built it will have to build it
    // again" — and left it in their pending inbox, because only the submitting device clears
    // its own record.
    expect(chainVerdict({spentInputs: 1, txHash: TX_HASH, producedOutputs: 2})).toEqual({
      kind: 'landed',
      txHash: TX_HASH,
    })
  })

  it('reports inputs spent by a different transaction as superseded', () => {
    expect(chainVerdict({spentInputs: 2, txHash: TX_HASH, producedOutputs: 0})).toEqual({
      kind: 'superseded',
      spentInputs: 2,
    })
  })

  it('never claims landed when the lookup could not be made — unknown is not success', () => {
    // The one wrong answer here that costs money: telling someone a send succeeded because a
    // read failed. `null` is "could not ask", and must fall to the pre-existing answer.
    expect(chainVerdict({spentInputs: 1, txHash: TX_HASH, producedOutputs: null})).toEqual({
      kind: 'superseded',
      spentInputs: 1,
    })
  })

  it('never claims landed when the body yielded no transaction id', () => {
    expect(chainVerdict({spentInputs: 1, txHash: null, producedOutputs: 3})).toEqual({
      kind: 'superseded',
      spentInputs: 1,
    })
  })

  it('carries the spent count through, so the superseded copy still counts coins', () => {
    expect(chainVerdict({spentInputs: 4, txHash: null, producedOutputs: null})).toMatchObject({spentInputs: 4})
  })
})

/**
 * `envelopeChainState`, which is the function that spends the two chain reads.
 *
 * ⚠️ It had no test, and it is where the spent-flag regression actually showed: with `spent`
 * always `undefined` the count was 0, so this returned `open` for every envelope whatever the
 * chain said, and a transaction that had landed stayed in a pending inbox forever. The stub here
 * answers `resolveOutRefs` and `getUtxosOfTransaction` independently, because the verdict needs
 * both and the pair is what distinguishes landed from superseded.
 */
describe('envelopeChainState', () => {
  const ADDRESS =
    'addr_test1qp8wl3hnya9l94rt58ky533deyqe9t8zz5n9su26k8e5g23yar4q0adtaax9q9g0kphpv2ws7vxqwu6ln6pqx7j29nfqnle9hh'
  const IN_HASH = '11'.repeat(32)

  let bodyHex: string

  beforeAll(async () => {
    const addressHex = Address.fromBech32Sync(Bech32(ADDRESS))
    bodyHex = TransactionBody.toCBORHex(
      TransactionBody.fromEncoded({
        inputs: [Bytes.fromHex(Tx.inputHex(TxHashHex(IN_HASH), 0n))],
        outputs: [
          TxOut.toCBORBytes(
            new TxOut.TransactionOutput({
              address: EvAddress.fromHex(addressHex),
              assets: Assets.fromLovelace(1_000_000n),
              encodingFormat: 'babbage',
            }),
          ),
        ],
        fee: 200_000n,
      }),
    )
  })

  const utxo = (index: bigint) =>
    new EvolutionUTxO.UTxO({
      transactionId: TransactionHash.fromHex(IN_HASH),
      index,
      address: EvolutionAddress.fromBech32(ADDRESS),
      assets: EvolutionAssets.fromLovelace(1_000_000n),
    })

  /** `spent` is the input's state; `produced` is what `getUtxosOfTransaction` answers. */
  const railWith = (spent: boolean | undefined, produced: number | 'refused') =>
    ({
      chain: {
        resolveOutRefs: () => Effect.succeed([{utxo: utxo(0n), ...(spent === undefined ? {} : {spent})}]),
        getUtxosOfTransaction: () =>
          produced === 'refused'
            ? Effect.fail(new EvolutionProvider.ProviderError({message: '503 upstream'}))
            : Effect.succeed(Array.from({length: produced}, (_, i) => utxo(BigInt(i)))),
      },
    }) as unknown as CardanoRail

  const run = (rail: CardanoRail) =>
    Effect.runPromise(
      envelopeChainState(rail, bodyHex).pipe(Effect.provide(EvolutionDecodeLayer)) as Effect.Effect<
        Awaited<ReturnType<typeof Effect.runPromise>>
      >,
    )

  it('is open while the chain says the input is still unspent', async () => {
    expect(await run(railWith(false, 0))).toEqual({kind: 'open'})
  })

  it('reads a landed transaction as landed, from its own produced outputs', async () => {
    const state = await run(railWith(true, 2))
    expect(state).toMatchObject({kind: 'landed'})
  })

  it('reads inputs spent with nothing produced as superseded', async () => {
    expect(await run(railWith(true, 0))).toMatchObject({kind: 'superseded', spentInputs: 1})
  })

  it('never claims landed when the produced-output read was refused', async () => {
    // `null` is "could not ask", and must fall back to the pre-existing answer rather than
    // telling someone a transaction succeeded because a read failed.
    expect(await run(railWith(true, 'refused'))).toMatchObject({kind: 'superseded', spentInputs: 1})
  })

  it('is open when the backend reports no spent flag, because undefined is unknown', async () => {
    expect(await run(railWith(undefined, 2))).toEqual({kind: 'open'})
  })
})
