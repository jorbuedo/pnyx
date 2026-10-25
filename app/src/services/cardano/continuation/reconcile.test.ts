import {
  Assets as EvAssets,
  Address as EvolutionAddress,
  Assets as EvolutionAssets,
  Provider as EvolutionProvider,
  UTxO as EvolutionUTxO,
  TransactionHash,
} from '@evolution-sdk/evolution'
import {MockProvider} from '@evolution-sdk/evolution/sdk/provider/Mock'
import {Plan} from '@evolution-sdk/plan'
import {Bech32, TxHashHex} from '@evolution-sdk/review/Brands'
import {layer as EvolutionDecodeLayer} from '@evolution-sdk/review/Decode'
import {Address, Tx, Wallet} from '@pnyx/cardano-core'
import {Effect, Layer} from 'effect'
import {beforeAll, describe, expect, it} from 'vitest'
import type {CardanoRailConfig} from '../config'
import {makeCardanoRail} from '../rail'
import {reconcileContinuation, reconcileVerdict} from './reconcile'
import {createContinuation} from './record'

describe('reconcileVerdict', () => {
  it('is complete when every leg landed', () => {
    expect(reconcileVerdict(['landed', 'landed'])).toEqual({landed: 2, nextIndex: 2, outcome: 'complete'})
  })

  it('resumes from the first leg that has not landed', () => {
    // The real shape of the mainnet failure: leg 1 in a block, leg 2 never submitted.
    expect(reconcileVerdict(['landed', 'submittable'])).toEqual({landed: 1, nextIndex: 1, outcome: 'resumable'})
  })

  it('is dead when the next leg cannot be submitted any more', () => {
    expect(reconcileVerdict(['landed', 'dead'])).toEqual({landed: 1, nextIndex: 1, outcome: 'dead'})
  })

  it('treats an unanswerable leg as unknown, never as dead or resumable', () => {
    // A provider outage must not invite a doomed resume, nor offer dismissal of live work.
    expect(reconcileVerdict(['unknown']).outcome).toBe('unknown')
    expect(reconcileVerdict(['landed', 'unknown']).outcome).toBe('unknown')
  })

  it('resumes from a gap rather than from the count of landed legs', () => {
    // Counting landed legs would say 2 and skip the middle leg entirely.
    expect(reconcileVerdict(['landed', 'submittable', 'landed'])).toEqual({
      landed: 2,
      nextIndex: 1,
      outcome: 'resumable',
    })
  })

  it('has nothing to do for an empty leg list', () => {
    expect(reconcileVerdict([])).toEqual({landed: 0, nextIndex: 0, outcome: 'complete'})
  })
})

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const CONFIG: CardanoRailConfig = {
  network: 'preprod',
  koiosUrl: 'https://koios.internal/api/v1',
  networkId: 0,
  protocolMagic: 1,
}
const IN_HASH = '11'.repeat(32)

let address: string
let bodyHex: string
let txId: string

beforeAll(async () => {
  address = await Effect.runPromise(
    Effect.gen(function* () {
      const account = yield* Wallet.fromMnemonic(MNEMONIC, 0)
      return yield* account.baseAddress(Address.Network.Testnet)
    }),
  )
  const addressHex = Address.fromBech32Sync(Bech32(address))
  const unsigned = Plan.buildUnsigned({
    inputs: [{txHash: TxHashHex(IN_HASH), index: 0, assets: EvAssets.fromLovelace(10_000_000n)}],
    outputs: [{addressHex, assets: EvAssets.fromLovelace(1_500_000n)}],
    changeAddressHex: addressHex,
    params: {
      minFeeA: 44n,
      minFeeB: 155_381n,
      coinsPerUtxoByte: 4_310n,
      keyDeposit: 2_000_000n,
      poolDeposit: 500_000_000n,
      drepDeposit: 500_000_000n,
    },
    signerCount: 1,
  })
  bodyHex = unsigned.bodyHex
  txId = Tx.bodyHash(bodyHex)
})

/**
 * What the chain says about this record's one input, and whether it has history at all.
 *
 * ⚠️ The outpoint's state is supplied DIRECTLY rather than derived from the mock's ledger,
 * because the five verdicts below turn on telling `spent: false` from `true` from **absent** —
 * and an absent flag means "the backend does not say", which a ledger cannot produce: it always
 * knows. The subject here is the reconciler's reading of the flag, so the flag is the fixture.
 */
type ChainSays = {
  /**
   * - `unspent` / `spent`: resolved, with the flag.
   * - `unsaid`: resolved, NO flag — the case that must read as unknown rather than resumable.
   * - `nothing`: the outpoint does not resolve at all, which is a fourth answer: it is gone.
   */
  readonly resolves: 'unspent' | 'spent' | 'unsaid' | 'nothing'
  /** Seeded transactions, which is what makes `getTxInfo` exist at all. */
  readonly txs?: Readonly<Record<string, EvolutionProvider.IndexedTx>>
}

const railWith = (says: ChainSays) =>
  makeCardanoRail({config: CONFIG, addressBech32: address, accountIndex: 0}).pipe(
    Effect.provide(
      Layer.mergeAll(
        EvolutionDecodeLayer,
        Layer.succeed(EvolutionProvider.ProviderEffect, {
          ...new MockProvider(says.txs === undefined ? {} : {txs: says.txs}).effect,
          resolveOutRefs: () =>
            Effect.succeed(
              says.resolves === 'nothing'
                ? []
                : [
                    {
                      utxo: consumedInput(),
                      ...(says.resolves === 'unsaid' ? {} : {spent: says.resolves === 'spent'}),
                    },
                  ],
            ),
        } as EvolutionProvider.ProviderEffect),
      ),
    ),
  )

/** The one input the stashed body spends. */
const consumedInput = () =>
  new EvolutionUTxO.UTxO({
    transactionId: TransactionHash.fromHex(IN_HASH),
    index: 0n,
    address: EvolutionAddress.fromBech32(address),
    assets: EvolutionAssets.fromLovelace(10_000_000n),
  })

const recordFor = (bodies: readonly string[]) =>
  createContinuation({
    groupId: 'g',
    continuationId: 'c1',
    context: 'cardano.signAll',
    expectedStepCount: bodies.length,
    contextData: {
      requests: bodies.map((hex) => ({groupId: 'g', payload: {_tag: 'CardanoTx', bodyHex: hex, networkId: 0}})),
    },
  })

/** ⚠️ `Decode` alone. Neither this nor `makeCardanoRail` needs a codec any more. */
const reconcile = (says: ChainSays, bodies: readonly string[] = [bodyHex]) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const rail = yield* railWith(says)
      return yield* reconcileContinuation(rail, recordFor(bodies))
    }).pipe(Effect.provide(EvolutionDecodeLayer)),
  )

describe('reconcileContinuation against a provider', () => {
  it('reads a leg as landed when its own transaction is on chain', async () => {
    const indexed: EvolutionProvider.IndexedTx = {
      txHash: TransactionHash.fromHex(txId),
      fee: 170_000n,
      inputs: [],
      outputs: [],
      withdrawals: [],
      certificates: [],
      mint: [],
    }
    const verdict = await reconcile({resolves: 'nothing', txs: {[txId]: indexed}})

    expect(verdict.legs).toEqual(['landed'])
    expect(verdict.outcome).toBe('complete')
  })

  it('reads a leg as dead when an input is already spent', async () => {
    const verdict = await reconcile({resolves: 'spent', txs: {}})

    expect(verdict.legs).toEqual(['dead'])
    expect(verdict.outcome).toBe('dead')
  })

  it('reads a leg as dead when an input cannot be resolved at all', async () => {
    const verdict = await reconcile({resolves: 'nothing', txs: {}})

    expect(verdict.legs).toEqual(['dead'])
  })

  it('is unknown when the inputs are gone and the backend has no history to say who took them', async () => {
    // ⚠️ A branch nothing covered: the old mock always served `txInfo`, so "spent by this very
    // leg (landed)" and "spent by anything else (dead)" could always be told apart. Without the
    // member they cannot, and the reconciler must say unknown rather than guess either way.
    const verdict = await reconcile({resolves: 'spent'})

    expect(verdict.legs).toEqual(['unknown'])
    expect(verdict.outcome).toBe('unknown')
  })

  it('reads a leg as submittable when its inputs are unspent', async () => {
    const verdict = await reconcile({resolves: 'unspent'})

    expect(verdict.legs).toEqual(['submittable'])
    expect(verdict.outcome).toBe('resumable')
  })

  it('is unknown when the backend reports no spent flag', async () => {
    // Koios does report it, but a provider that does not must not be read as "unspent".
    const verdict = await reconcile({resolves: 'unsaid'})

    expect(verdict.legs).toEqual(['unknown'])
    expect(verdict.outcome).toBe('unknown')
  })

  it('is unknown for a record that stashed no legs', async () => {
    const verdict = await Effect.runPromise(
      Effect.gen(function* () {
        const rail = yield* railWith({resolves: 'nothing'})
        return yield* reconcileContinuation(
          rail,
          createContinuation({groupId: 'g', continuationId: 'c2', context: 'x', expectedStepCount: 2}),
        )
      }).pipe(Effect.provide(EvolutionDecodeLayer)),
    )

    expect(verdict.outcome).toBe('unknown')
    expect(verdict.legs).toEqual([])
  })
})
