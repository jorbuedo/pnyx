import type {UTxO as EvolutionUTxO} from '@evolution-sdk/evolution'
import {AddressHex} from '@evolution-sdk/review/Brands'
import {layer as EvolutionDecodeLayer} from '@evolution-sdk/review/Decode'
import {Address, Wallet} from '@pnyx/cardano-core'
import {utxoId} from '@pnyx/wallet'
import {Effect, Layer} from 'effect'
import {beforeAll, describe, expect, it} from 'vitest'
import {ADA_ID} from '../../screens/cardano/send/state'
import type {CardanoRailConfig} from './config'
import {makeCardanoRail} from './rail'
import {buildEnhancedSendReview, buildSendReview, pendingTxFrom} from './send-flow'
import {chainUtxo, mockChain} from './test-provider'
import {utxoAssetMap} from './utxo-view'

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const RECIPIENT_MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow'
const GROUP = 'group-send'

const CONFIG: CardanoRailConfig = {
  network: 'preprod',
  koiosUrl: 'https://first-party.example/koios',
  networkId: 0,
  protocolMagic: 1,
}

type Fixture = {
  readonly ownAddress: string
  readonly secondAddress: string
  readonly secondPaymentKeyHash: string
  readonly recipientHex: string
}

let fx: Fixture

beforeAll(async () => {
  fx = await Effect.runPromise(
    Effect.gen(function* () {
      const own = yield* Wallet.fromMnemonic(MNEMONIC, 0)
      const recipient = yield* Wallet.fromMnemonic(RECIPIENT_MNEMONIC, 0)
      const ownAddress = yield* own.baseAddress(Address.Network.Testnet)
      const secondAddress = yield* own.baseAddress(Address.Network.Testnet, 1)
      const secondPaymentKeyHash = Address.inspect((yield* Address.fromBech32(secondAddress)) as string)
        .paymentCredHex as string
      const recipientBech = yield* recipient.baseAddress(Address.Network.Testnet)
      const recipientHex = (yield* Address.fromBech32(recipientBech)) as string
      return {ownAddress, secondAddress, secondPaymentKeyHash, recipientHex}
    }),
  )
})

const railWith = (utxos: readonly EvolutionUTxO.UTxO[]) =>
  makeCardanoRail({config: CONFIG, addressBech32: fx.ownAddress, accountIndex: 0}).pipe(
    Effect.provide(Layer.mergeAll(EvolutionDecodeLayer, mockChain({utxos: [...utxos]}))),
  )

describe('buildSendReview', () => {
  it('builds an unsigned ADA send with review IR and pending-tracking info', async () => {
    const review = await Effect.runPromise(
      Effect.gen(function* () {
        const rail = yield* railWith([
          chainUtxo({address: fx.ownAddress, txHash: '11', index: 0, lovelace: 10_000_000n}),
        ])
        yield* rail.sync
        return yield* buildSendReview(rail, GROUP, {
          toAddressHex: AddressHex(fx.recipientHex),
          amountLovelace: 3_000_000n,
        })
      }),
    )

    expect(review.reviewed.chain).toBe('cardano')
    // one counterparty (the recipient) receives 3 ADA
    const recipientParty = review.reviewed.counterparties.find((p) => p.address.hex === fx.recipientHex)
    expect(recipientParty?.received).toEqual([{quantity: 3_000_000n}])
    // net own delta is negative (spent 10 ADA input, got change back, fee paid)
    const ownCoin = review.reviewed.ownDelta.find((a) => a.assetId === undefined)
    expect(ownCoin?.quantity).toBeLessThan(0n)
    // consumed the single available input; change is tracked for the pending overlay
    expect(review.tracked.consumedUtxoIds).toEqual([`${'11'.repeat(32)}:0`])
    expect(review.tracked.change.length).toBe(1)
    // the request is a broadcastable CardanoTx on the configured network
    expect(review.request.payload._tag).toBe('CardanoTx')
    expect(review.request.groupId).toBe(GROUP)
  })

  it('gives every input a bech32 address, so input rows read like output rows', async () => {
    const review = await Effect.runPromise(
      Effect.gen(function* () {
        const rail = yield* railWith([
          chainUtxo({address: fx.ownAddress, txHash: '11', index: 0, lovelace: 10_000_000n}),
        ])
        yield* rail.sync
        return yield* buildSendReview(rail, GROUP, {
          toAddressHex: AddressHex(fx.recipientHex),
          amountLovelace: 3_000_000n,
        })
      }),
    )

    const input = review.reviewed.inputs[0]
    expect(input?.address.bech32).toMatch(/^addr(_test)?1/)
    // Outputs are decoded from the body and always had one; inputs are resolved from our
    // own UTxO set, where the bech32 form was in hand and was being dropped.
    expect(review.reviewed.outputs[0]?.address.bech32).toMatch(/^addr(_test)?1/)
  })

  it('fails with empty-wallet when there are no spendable UTxOs', async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        Effect.gen(function* () {
          const rail = yield* railWith([])
          yield* rail.sync
          return yield* buildSendReview(rail, GROUP, {
            toAddressHex: AddressHex(fx.recipientHex),
            amountLovelace: 1_000_000n,
          })
        }),
      ),
    )
    expect((error as unknown as {kind: string}).kind).toBe('empty-wallet')
  })

  it('fails with insufficient-funds when the amount exceeds the balance', async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        Effect.gen(function* () {
          const rail = yield* railWith([
            chainUtxo({address: fx.ownAddress, txHash: '22', index: 0, lovelace: 2_000_000n}),
          ])
          yield* rail.sync
          return yield* buildSendReview(rail, GROUP, {
            toAddressHex: AddressHex(fx.recipientHex),
            amountLovelace: 100_000_000n,
          })
        }),
      ),
    )
    expect((error as unknown as {kind: string}).kind).toBe('insufficient-funds')
  })

  it('the tracked change utxo lives at the tx id (chaining input for a dependent tx)', async () => {
    const {review, changeId} = await Effect.runPromise(
      Effect.gen(function* () {
        const rail = yield* railWith([
          chainUtxo({address: fx.ownAddress, txHash: '33', index: 0, lovelace: 10_000_000n}),
        ])
        yield* rail.sync
        const review = yield* buildSendReview(rail, GROUP, {
          toAddressHex: AddressHex(fx.recipientHex),
          amountLovelace: 3_000_000n,
        })
        const change = review.tracked.change[0]
        return {review, changeId: change ? utxoId(change) : null}
      }),
    )
    expect(changeId).not.toBeNull()
    // pendingTxFrom threads the tracking info into a registerable overlay entry
    const pending = pendingTxFrom('deadbeef', review.tracked, 1_000)
    expect(pending.txHash).toBe('deadbeef')
    expect(pending.change).toBe(review.tracked.change)
    expect(pending.consumedUtxoIds).toEqual(review.tracked.consumedUtxoIds)
  })
})

describe('ADA send-all reclaims the fee cushion', () => {
  // The cushion is handed to the recipient in a second pass so a send-all leaves
  // zero change. That pass measured its bump against `built.fee` — which already
  // has the folded cushion inside it when the first pass dust-folded, so the bump
  // computed to zero and the cushion stayed in the fee. Observed on device: a
  // 4-in/1-out send paying exactly 1.000000 ADA of fee, the whole reserve.
  const USDA_POLICY = 'fe7c786ab321f41c654ef6c1af7b3250a613c24e4213e0425a7ae456'
  const USDA_NAME = '55534441'
  const USDA_QTY = 1_209_988n
  /** Sums to 8_550_903; the top three (7_500_000) cannot cover the send, so all four are spent. */
  const FUNDS = (): readonly EvolutionUTxO.UTxO[] => [
    chainUtxo({
      address: fx.ownAddress,
      txHash: '77',
      lovelace: 3_000_000n,
      assets: [[USDA_POLICY, USDA_NAME, USDA_QTY]],
    }),
    chainUtxo({address: fx.ownAddress, txHash: '88', lovelace: 2_500_000n}),
    chainUtxo({address: fx.ownAddress, txHash: '99', lovelace: 2_000_000n}),
    chainUtxo({address: fx.ownAddress, txHash: 'aa', lovelace: 1_050_903n}),
  ]
  const TOTAL_ADA = 8_550_903n
  const RESERVE = 1_000_000n

  /** Send-all of ADA (balance − reserve, exactly what `validateSend` resolves) plus every USDA. */
  const sendAll = () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const rail = yield* railWith(FUNDS())
        yield* rail.sync
        // Read the asset id off the wallet's own view rather than re-deriving the
        // policy/name join here — the build keys outputs by the same id.
        const spendable = yield* rail.spendableUtxos
        const usdaId = [...(spendable.flatMap((u) => [...utxoAssetMap(u)]) as [string, bigint][])][0]?.[0]
        expect(usdaId).toBeDefined()
        return yield* buildEnhancedSendReview(rail, GROUP, {
          targets: [
            {
              addressHex: AddressHex(fx.recipientHex),
              amounts: new Map([
                [ADA_ID, TOTAL_ADA - RESERVE],
                [usdaId as string, USDA_QTY],
              ]),
            },
          ],
          adaSendAll: {targetIndex: 0, reserve: RESERVE},
        })
      }),
    )

  it('does not fold the cushion into the fee', async () => {
    const review = await sendAll()

    expect(review.reviewed.warnings).not.toContain('change-folded-into-fee')
    expect(review.reviewed.warnings).not.toContain('large-fee')
    // The whole point: the fee is the protocol cost, nowhere near the reserve.
    expect(review.reviewed.fee).toBeLessThan(RESERVE)
    expect(review.reviewed.fee).toBeLessThan(500_000n)
  })

  it('gives the recipient the cushion instead, leaving no change', async () => {
    const review = await sendAll()

    const recipient = review.reviewed.counterparties.find((p) => p.address.hex === fx.recipientHex)
    const receivedAda = recipient?.received.find((a) => a.assetId === undefined)?.quantity
    expect(receivedAda).toBeGreaterThan(TOTAL_ADA - RESERVE)
    // A send-all that leaves change has not sent all of it.
    expect(review.tracked.change).toEqual([])
    // Value conservation: every lovelace went to the recipient or the fee.
    expect((receivedAda as bigint) + review.reviewed.fee).toBe(TOTAL_ADA)
  })

  it('spends all four inputs, so the fold path is the one under test', async () => {
    const review = await sendAll()
    expect(review.tracked.consumedUtxoIds).toHaveLength(FUNDS().length)
  })
})

describe('spending across several of the account’s own addresses', () => {
  // Every input must be attributed to the address it actually sits at, and the
  // wallet must hold a signing path for each. Getting either wrong ships a
  // transaction missing a witness, which the ledger rejects — and it was wrong on
  // both counts: every input was labelled with the primary address, and the key
  // registry only ever held the primary payment path.
  const railAcross = (utxos: readonly EvolutionUTxO.UTxO[], addressPaths?: ReadonlyMap<string, string>) =>
    makeCardanoRail({
      config: CONFIG,
      addressBech32: fx.ownAddress,
      accountIndex: 0,
      extraAddresses: [fx.secondAddress],
      ...(addressPaths !== undefined ? {addressPaths} : {}),
    }).pipe(Effect.provide(Layer.mergeAll(EvolutionDecodeLayer, mockChain({utxos: [...utxos]}))))

  /**
   * Both addresses hold 6 ADA, so a 10 ADA send has to reach into both.
   *
   * ⚠️ One flat array: the mock keys its ledger on each row's OWN address, so the second UTxO
   * sitting at `secondAddress` is what puts it there. The map this replaced keyed one entry
   * under `secondAddress` while the row inside it still carried the primary — which is the
   * exact mislabelling the two assertions below exist to catch, written into the fixture.
   */
  const spread = () => [
    chainUtxo({address: fx.ownAddress, txHash: '44', lovelace: 6_000_000n}),
    chainUtxo({address: fx.secondAddress, txHash: '55', lovelace: 6_000_000n}),
  ]

  const build = (addressPaths?: ReadonlyMap<string, string>) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const rail = yield* railAcross(spread(), addressPaths)
        yield* rail.sync
        // The enhanced builder is the one the funnel uses, and the only one that
        // precomputes signing paths for the ceremony.
        const review = yield* buildEnhancedSendReview(rail, GROUP, {
          targets: [{addressHex: AddressHex(fx.recipientHex), amounts: new Map([['', 10_000_000n]])}],
        })
        return {review, rail}
      }),
    )

  it('requires a payment credential for each address it spent from', async () => {
    const {review, rail} = await build(new Map([[fx.secondAddress, "m/1852'/1815'/0'/0/1"]]))

    expect(review.tracked.consumedUtxoIds).toHaveLength(2)
    const required = review.request.payload.precomputedRequiredKeyHashes ?? []
    expect(required).toContain(rail.account.paymentKeyHashHex)
    expect(required).toContain(fx.secondPaymentKeyHash)
  })

  it('resolves a signing path for each of them, so every required witness can be produced', async () => {
    const {review} = await build(new Map([[fx.secondAddress, "m/1852'/1815'/0'/0/1"]]))

    const paths = review.request.payload.precomputedSigningPaths ?? []
    expect(paths).toContain("m/1852'/1815'/0'/0/0")
    expect(paths).toContain("m/1852'/1815'/0'/0/1")
    // Nothing required may be left without a path: the signing service produces
    // one witness per path and then fails the coverage check, so a gap here is a
    // transaction that cannot be signed.
    const required = review.request.payload.precomputedRequiredKeyHashes ?? []
    expect(paths.length).toBeGreaterThanOrEqual(required.length)
  })

  it('leaves an address out of the registry when its path is unknown, rather than guessing one', async () => {
    // A wrong path derives a wrong key and produces a witness the ledger rejects,
    // so the honest outcome is a missing path the coverage check can catch.
    const {review} = await build()

    const paths = review.request.payload.precomputedSigningPaths ?? []
    const required = review.request.payload.precomputedRequiredKeyHashes ?? []
    expect(paths).toEqual(["m/1852'/1815'/0'/0/0"])
    expect(required).toContain(fx.secondPaymentKeyHash)
  })

  it('sizes the fee for both witnesses, not for one', async () => {
    const {review} = await build(new Map([[fx.secondAddress, "m/1852'/1815'/0'/0/1"]]))
    const twoWitnessFee = review.reviewed.fee

    // Same spend from a single address needs one witness, so it must cost less.
    const single = await Effect.runPromise(
      Effect.gen(function* () {
        // Only the primary is funded, so only one witness is required.
        const rail = yield* railAcross([chainUtxo({address: fx.ownAddress, txHash: '66', lovelace: 12_000_000n})])
        yield* rail.sync
        return yield* buildEnhancedSendReview(rail, GROUP, {
          targets: [{addressHex: AddressHex(fx.recipientHex), amounts: new Map([['', 10_000_000n]])}],
        })
      }),
    )

    expect(twoWitnessFee).toBeGreaterThan(single.reviewed.fee)
  })
})
