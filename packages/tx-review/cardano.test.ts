import {
  Assets,
  Bytes,
  CBOR,
  Address as EvAddress,
  InlineDatum,
  RewardAccount,
  ScriptRef,
  TransactionBody,
  TxOut,
  Withdrawals,
} from '@evolution-sdk/evolution'
import type {Plan} from '@evolution-sdk/plan'
import {AddressHex, KeyHashHex, TxHashHex, type XprvHex} from '@evolution-sdk/review/Brands'
import {layer as EvolutionDecodeLayer} from '@evolution-sdk/review/Decode'
import * as Inspect from '@evolution-sdk/review/Inspect'
import {Address, Body, Certs, Gov, Keys, Tx, Wallet} from '@pnyx/cardano-core'
import {Effect} from 'effect'
import {beforeAll, describe, expect, it} from 'vitest'
import {LARGE_FEE_LOVELACE, reviewCardanoTx} from './cardano.js'
import {resolveCardanoSigningPaths} from './signing-paths.js'
import type {ResolvedInput, WalletContext} from './types.js'

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const OTHER_MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow'
const PAYMENT_PATH = "m/1852'/1815'/0'/0/0"
const STAKE_PATH = "m/1852'/1815'/0'/2/0"

const PARAMS: Plan.ProtocolParams = {
  minFeeA: 44n,
  minFeeB: 155_381n,
  coinsPerUtxoByte: 4_310n,
  keyDeposit: 2_000_000n,
  poolDeposit: 500_000_000n,
  drepDeposit: 500_000_000n,
}

const testLayer = EvolutionDecodeLayer

type Fixture = {
  readonly ownAddrHex: AddressHex
  readonly otherAddrHex: AddressHex
  /** Our payment key with the other wallet's stake key — a multi-delegation address. */
  readonly multiDelegationAddrHex: AddressHex
  /** A base address whose payment credential is a script hash, not a key hash. */
  readonly scriptAddrHex: AddressHex
  readonly paymentKeyHash: KeyHashHex
  readonly stakeKeyHash: KeyHashHex
  readonly rewardAcctHex: AddressHex
  /** The other wallet's reward account — a stake credential we do not manage. */
  readonly otherRewardAcctHex: AddressHex
  readonly paymentXprv: XprvHex
  readonly paymentVkey: string
  readonly context: WalletContext
}

let fx: Fixture

beforeAll(async () => {
  fx = await Effect.runPromise(
    Effect.gen(function* () {
      const own = yield* Wallet.fromMnemonic(MNEMONIC, 0)
      const other = yield* Wallet.fromMnemonic(OTHER_MNEMONIC, 0)
      const ownAddrHex = Address.fromBech32Sync(yield* own.baseAddress(Address.Network.Testnet))
      const otherAddrHex = Address.fromBech32Sync(yield* other.baseAddress(Address.Network.Testnet))
      const paymentKeyHash = yield* own.paymentKeyHash()
      const stakeKeyHash = yield* own.stakeKeyHash
      const otherStakeKeyHash = yield* other.stakeKeyHash
      const multiDelegationAddrHex = Address.baseHex(Address.Network.Testnet, paymentKeyHash, otherStakeKeyHash)
      const scriptAddrHex = Address.baseScriptScriptHex(Address.Network.Testnet, '99'.repeat(28), '88'.repeat(28))
      const rewardAcctHex = Address.fromBech32Sync(yield* own.rewardAddress(Address.Network.Testnet))
      const otherRewardAcctHex = Address.fromBech32Sync(yield* other.rewardAddress(Address.Network.Testnet))
      const paymentXprv = yield* own.paymentKey()
      const paymentVkey = Keys.publicKeySync(paymentXprv)
      return {
        ownAddrHex,
        otherAddrHex,
        multiDelegationAddrHex,
        scriptAddrHex,
        paymentKeyHash,
        stakeKeyHash,
        rewardAcctHex,
        otherRewardAcctHex,
        paymentXprv,
        paymentVkey,
        context: {paymentKeyHashes: new Set([paymentKeyHash]), stakeKeyHashHex: stakeKeyHash},
      }
    }).pipe(Effect.provide(testLayer)),
  )
})

const OWN_UTXO_HASH = '11'.repeat(32)
const FOREIGN_UTXO_HASH = '22'.repeat(32)

const ownInput = (coin: bigint): ResolvedInput => ({
  txHashHex: OWN_UTXO_HASH,
  index: 0,
  addressHex: fx.ownAddrHex,
  coin,
  tokens: [],
})

type BodyParts = {
  readonly inputs?: readonly {hash: string; index: number}[]
  readonly outputs?: readonly {
    addressHex: string
    coin: bigint
    /** Raw plutus_data CBOR, attached as a Babbage inline datum (key 2). */
    datumInlineHex?: string
    /** Raw script CBOR, attached as a reference script (key 3). */
    scriptRefHex?: string
  }[]
  readonly fee?: bigint
  readonly ttl?: bigint
  readonly certHexes?: readonly string[]
  readonly withdrawals?: readonly {rewardAcctHex: string; amount: bigint}[]
  /** Raw body-map entries [key, cbor-hex] (e.g. voting=19, proposals=20). */
  readonly bodyExtra?: readonly (readonly [number, string])[]
}

/**
 * A real transaction body, assembled the way the wallet assembles one.
 *
 * ⚠️ Through Evolution's own constructors, not a codec. The point of these fixtures is that the
 * reviewer reads bodies with the SAME bytes the builder produces, so building them through a
 * second encoder would make the reviewer's agreement with the builder unobservable here.
 *
 * ⚠️ `encodingFormat: 'babbage'` on every output: Conway accepts the Shelley array too and
 * Evolution defaults to it, so without this the fixtures would be a shape the wallet never emits.
 */
const buildBody = (parts: BodyParts): string => {
  const inputs = (parts.inputs ?? [{hash: OWN_UTXO_HASH, index: 0}]).map((i) =>
    Bytes.fromHex(Tx.inputHex(TxHashHex(i.hash), BigInt(i.index))),
  )
  const outputs = (parts.outputs ?? [{addressHex: fx.otherAddrHex, coin: 800_000n}]).map((o) =>
    TxOut.toCBORBytes(
      new TxOut.TransactionOutput({
        address: EvAddress.fromHex(AddressHex(o.addressHex)),
        assets: Assets.fromLovelace(o.coin),
        encodingFormat: 'babbage',
        ...(o.datumInlineHex === undefined ? {} : {datumOption: InlineDatum.fromCBORHex(o.datumInlineHex)}),
        ...(o.scriptRefHex === undefined ? {} : {scriptRef: ScriptRef.fromHex(o.scriptRefHex)}),
      }),
    ),
  )
  const extras: (readonly [number, Uint8Array])[] = []
  if (parts.certHexes?.length) {
    extras.push([4, CBOR.encodeTaggedSet(parts.certHexes.map((c) => Bytes.fromHex(c)))])
  }
  if (parts.withdrawals?.length) {
    extras.push([
      5,
      Bytes.fromHex(
        Withdrawals.toCBORHex(
          Withdrawals.fromEntries(parts.withdrawals.map((w) => [RewardAccount.fromHex(w.rewardAcctHex), w.amount])),
        ),
      ),
    ])
  }
  for (const [key, hex] of parts.bodyExtra ?? []) extras.push([key, Bytes.fromHex(hex)])
  return TransactionBody.toCBORHex(
    TransactionBody.fromEncoded({
      inputs,
      outputs,
      fee: parts.fee ?? 200_000n,
      ...(parts.ttl === undefined ? {} : {ttl: parts.ttl}),
      fields: extras,
    }),
  )
}

const run = <A>(eff: Effect.Effect<A, unknown, never>): Promise<A> => Effect.runPromise(eff as Effect.Effect<A>)
const review = (bodyHex: string, input = ownInput(1_000_000n), feeBreakdown?: Plan.FeeBreakdown) =>
  run(reviewCardanoTx(bodyHex, fx.context, [input], PARAMS, undefined, feeBreakdown).pipe(Effect.provide(testLayer)))

/** A breakdown as `Plan.buildPlan*` reports it, with only the fields under test set. */
const breakdown = (over: Partial<Plan.FeeBreakdown> = {}): Plan.FeeBreakdown => ({
  linear: 200_000n,
  scriptExecution: 0n,
  refScript: 0n,
  foldedFromChange: 0n,
  total: 200_000n,
  sentCoin: 10_000_000n,
  ...over,
})
const cert1 = (eff: Effect.Effect<string, unknown>) => run(eff)

describe('reviewCardanoTx', () => {
  it('classifies ownership and nets the own delta on a simple payment', async () => {
    const bodyHex = buildBody({
      inputs: [{hash: OWN_UTXO_HASH, index: 0}],
      outputs: [
        {addressHex: fx.otherAddrHex, coin: 700_000n},
        {addressHex: fx.ownAddrHex, coin: 100_000n},
      ],
      fee: 200_000n,
      ttl: 99_000_000n,
    })
    const r = await review(bodyHex)
    expect(r.chain).toBe('cardano')
    expect(r.fee).toBe(200_000n)
    expect(r.inputs).toHaveLength(1)
    expect(r.inputs[0]?.ownership).toEqual({level: 'own', owner: 'wallet'})
    expect(r.unresolvedInputs).toHaveLength(0)
    expect(r.outputs.map((o) => o.ownership)).toEqual([{level: 'none'}, {level: 'own', owner: 'wallet'}])
    expect(r.ownDelta).toEqual([{quantity: -900_000n}])
    expect(r.counterparties).toHaveLength(1)
    expect(r.counterparties[0]?.received).toEqual([{quantity: 700_000n}])
    // groups: own party nets −900k sent, external party receives 700k
    expect(r.ownGroup.parties[0]?.sent).toEqual([{quantity: 900_000n}])
    expect(r.otherGroup.parties[0]?.received).toEqual([{quantity: 700_000n}])
    expect(r.warnings).not.toContain('no-ttl')
    expect(r.warnings).not.toContain('large-fee')
  })

  it('marks an input spending an unconfirmed parent, and warns', async () => {
    // Chained sends: leg B spends leg A's change before A confirms. The wallet's
    // spendable view merges confirmed and virtual UTxOs on purpose, so without
    // this the review shows an ordinary own-wallet input and never says the
    // transaction is contingent on another one landing.
    const bodyHex = buildBody({inputs: [{hash: OWN_UTXO_HASH, index: 0}]})
    const r = await run(
      reviewCardanoTx(bodyHex, fx.context, [{...ownInput(1_000_000n), fromUnconfirmedTx: true}], PARAMS).pipe(
        Effect.provide(testLayer),
      ),
    )
    expect(r.inputs[0]?.fromUnconfirmedTx).toBe(true)
    expect(r.warnings).toContain('spends-unconfirmed-input')
  })

  it('does not warn when every input is confirmed', async () => {
    const r = await review(buildBody({inputs: [{hash: OWN_UTXO_HASH, index: 0}]}))
    expect(r.inputs[0]?.fromUnconfirmedTx).toBeUndefined()
    expect(r.warnings).not.toContain('spends-unconfirmed-input')
  })

  it('carries an output inline datum and reference script, and preserves their absence', async () => {
    // Without these an output that a script will later read is indistinguishable
    // from a plain payment of the same value.
    const datumHex = 'd87980' // plutus_data: constructor 0, no fields
    const scriptHex = '46010000222601'
    const bodyHex = buildBody({
      outputs: [
        {addressHex: fx.otherAddrHex, coin: 700_000n, datumInlineHex: datumHex},
        {addressHex: fx.otherAddrHex, coin: 700_000n, scriptRefHex: scriptHex},
        {addressHex: fx.ownAddrHex, coin: 100_000n},
      ],
    })
    const r = await review(bodyHex)
    expect(r.outputs[0]?.datum).toEqual({kind: 'inline', hex: datumHex})
    expect(r.outputs[0]?.refScript).toBeUndefined()
    expect(r.outputs[1]?.refScript).toEqual({hex: scriptHex})
    expect(r.outputs[1]?.datum).toBeUndefined()
    // A plain output must not gain an empty attachment.
    expect(r.outputs[2]?.datum).toBeUndefined()
    expect(r.outputs[2]?.refScript).toBeUndefined()
  })

  it('names each resolved input by the outpoint it spends, and leaves outputs without one', async () => {
    const r = await review(
      buildBody({
        inputs: [{hash: OWN_UTXO_HASH, index: 0}],
        outputs: [{addressHex: fx.otherAddrHex, coin: 700_000n}],
        ttl: 99_000_000n,
      }),
    )
    expect(r.inputs[0]?.outpoint).toEqual({txHashHex: OWN_UTXO_HASH, index: 0})
    // The tx has no hash until it is submitted, so its outputs have no identity yet.
    expect(r.outputs[0]?.outpoint).toBeUndefined()
  })

  it('surfaces unresolved (foreign) inputs', async () => {
    const bodyHex = buildBody({
      inputs: [
        {hash: OWN_UTXO_HASH, index: 0},
        {hash: FOREIGN_UTXO_HASH, index: 3},
      ],
    })
    const r = await review(bodyHex)
    expect(r.unresolvedInputs).toEqual([{txHashHex: FOREIGN_UTXO_HASH, index: 3}])
    expect(r.warnings).toContain('unresolved-inputs')
  })

  it('classifies an escrow output and warns on a hijacked stake credential', async () => {
    // Two outputs sharing OUR stake credential: one behind a script (our escrow
    // position) and one behind a stranger's payment key (the mangled-address
    // shape). They were indistinguishable before the ownership split.
    const escrowHex = Address.baseScriptHex(Address.Network.Testnet, '99'.repeat(28), fx.stakeKeyHash)
    const hijackHex = Address.baseHex(Address.Network.Testnet, 'ee'.repeat(28), fx.stakeKeyHash)
    const bodyHex = buildBody({
      inputs: [{hash: OWN_UTXO_HASH, index: 0}],
      outputs: [
        {addressHex: escrowHex, coin: 400_000n},
        {addressHex: hijackHex, coin: 300_000n},
      ],
      ttl: 99_000_000n,
    })

    const r = await review(bodyHex)

    expect(r.outputs.map((o) => o.ownership)).toEqual([
      {level: 'escrow', owner: 'wallet'},
      {level: 'stake-hijack', owner: 'wallet'},
    ])
    expect(r.warnings).toContain('stake-credential-reuse')
  })

  it('does not warn about stake reuse for an ordinary payment', async () => {
    const r = await review(
      buildBody({
        inputs: [{hash: OWN_UTXO_HASH, index: 0}],
        outputs: [{addressHex: fx.otherAddrHex, coin: 700_000n}],
        ttl: 99_000_000n,
      }),
    )
    expect(r.warnings).not.toContain('stake-credential-reuse')
  })

  describe('leaked-signing-key', () => {
    // The detector itself lives in @pnyx/crypto; this package only asks the
    // question, so these cover the wiring: which witnesses get asked, and what
    // "nobody asked" means.
    const withWitnesses = async (
      leaks?: (vkeyHex: string, signatureHex: string) => boolean,
      parts: BodyParts = {ttl: 99_000_000n},
    ) => {
      const bodyHex = buildBody(parts)
      const witness = await run(Tx.partialSign(bodyHex, fx.paymentXprv).pipe(Effect.provide(testLayer)))
      const signedTxHex = await run(Tx.assemble(bodyHex, [witness]).pipe(Effect.provide(testLayer)))
      const witnessHex = await run(Inspect.witnessSetFromTx(signedTxHex).pipe(Effect.provide(testLayer)))
      return run(
        reviewCardanoTx(
          bodyHex,
          fx.context,
          [ownInput(1_000_000n)],
          PARAMS,
          witnessHex,
          undefined,
          undefined,
          leaks,
        ).pipe(Effect.provide(testLayer)),
      )
    }

    it('warns when the injected predicate flags a witness', async () => {
      const r = await withWitnesses(() => true)
      expect(r.warnings).toContain('leaked-signing-key')
      // First, so the banner list leads with it.
      expect(r.warnings[0]).toBe('leaked-signing-key')
    })

    it('stays silent when the predicate clears every witness', async () => {
      const r = await withWitnesses(() => false)
      expect(r.warnings).not.toContain('leaked-signing-key')
    })

    it('stays silent when no predicate was supplied — unasked is not clean', async () => {
      const r = await withWitnesses()
      expect(r.warnings).not.toContain('leaked-signing-key')
    })

    it('marks the offending witness, not just the transaction', async () => {
      // The banner says "a signature"; the Signatures tab has to say which one.
      const r = await withWitnesses((vkeyHex) => vkeyHex === fx.paymentVkey)
      expect(r.witnessSet?.map((w) => [w.vkeyHex, w.leaksSigningKey])).toEqual([[fx.paymentVkey, true]])
    })
  })

  describe('witness identification', () => {
    const reviewWitnessed = async (parts: BodyParts) => {
      const bodyHex = buildBody(parts)
      const witness = await run(Tx.partialSign(bodyHex, fx.paymentXprv).pipe(Effect.provide(testLayer)))
      const signedTxHex = await run(Tx.assemble(bodyHex, [witness]).pipe(Effect.provide(testLayer)))
      const witnessHex = await run(Inspect.witnessSetFromTx(signedTxHex).pipe(Effect.provide(testLayer)))
      return run(
        reviewCardanoTx(bodyHex, fx.context, [ownInput(1_000_000n)], PARAMS, witnessHex).pipe(
          Effect.provide(testLayer),
        ),
      )
    }

    it('hashes each vkey and recognises our own key', async () => {
      const r = await reviewWitnessed({ttl: 99_000_000n})
      expect(r.witnessSet?.[0]).toMatchObject({
        vkeyHex: fx.paymentVkey,
        keyHashHex: fx.paymentKeyHash,
        owner: 'wallet',
        satisfiesRequiredSigner: false,
        leaksSigningKey: false,
      })
    })

    it('matches a witness against the body’s required_signers', async () => {
      const r = await reviewWitnessed({
        ttl: 99_000_000n,
        bodyExtra: [[14, Body.requiredSignersSync([fx.paymentKeyHash])]],
      })
      expect(r.requiredSigners).toEqual([fx.paymentKeyHash])
      expect(r.witnessSet?.[0]?.satisfiesRequiredSigner).toBe(true)
    })

    it('does not call a transaction multi-party when every required signer is ours', async () => {
      // A script that authorises on the stake credential needs both our payment and stake
      // keys, and both are signed in the same ceremony with no further action. Telling the
      // user it "needs more than one signature before it can be submitted" sent them
      // waiting for a co-signer that does not exist.
      const r = await review(
        buildBody({
          inputs: [{hash: OWN_UTXO_HASH, index: 0}],
          bodyExtra: [[14, Body.requiredSignersSync([fx.paymentKeyHash, fx.stakeKeyHash])]],
        }),
      )
      expect(r.warnings).not.toContain('multi-sig')
    })

    it('does call it multi-party when a required signer is not ours', async () => {
      const foreignHash = KeyHashHex('ab'.repeat(28))
      const r = await review(
        buildBody({
          inputs: [{hash: OWN_UTXO_HASH, index: 0}],
          bodyExtra: [[14, Body.requiredSignersSync([fx.paymentKeyHash, foreignHash])]],
        }),
      )
      expect(r.warnings).toContain('multi-sig')
    })

    it('leaves a foreign key unowned rather than guessing', async () => {
      const {stakeKeyHashHex: _noStakeKey, ...rest} = fx.context
      const foreign = {...rest, paymentKeyHashes: new Set<string>()}
      const bodyHex = buildBody({ttl: 99_000_000n})
      const witness = await run(Tx.partialSign(bodyHex, fx.paymentXprv).pipe(Effect.provide(testLayer)))
      const signedTxHex = await run(Tx.assemble(bodyHex, [witness]).pipe(Effect.provide(testLayer)))
      const witnessHex = await run(Inspect.witnessSetFromTx(signedTxHex).pipe(Effect.provide(testLayer)))
      const r = await run(reviewCardanoTx(bodyHex, foreign, [], PARAMS, witnessHex).pipe(Effect.provide(testLayer)))
      expect(r.witnessSet?.[0]?.owner).toBeUndefined()
      expect(r.witnessSet?.[0]?.keyHashHex).toBe(fx.paymentKeyHash)
    })
  })

  it('carries the bytes it decoded, named as a body — it never sees a signed transaction', async () => {
    // Details labels the copy row off `kind`; pasting a bare body where a whole
    // transaction is expected fails opaquely, so the producer has to say which.
    const bodyHex = buildBody({ttl: 99_000_000n})
    expect((await review(bodyHex)).cbor).toEqual({hex: bodyHex, kind: 'body'})
  })

  it('flags large fees and missing ttl', async () => {
    const r = await review(buildBody({fee: LARGE_FEE_LOVELACE + 1n}), ownInput(10_000_000n))
    expect(r.warnings).toContain('large-fee')
    expect(r.warnings).toContain('no-ttl')
  })

  describe('fee breakdown tiering', () => {
    it('flags a sub-5-ADA fee that is a large share of what was sent AND above the protocol minimum', async () => {
      // 2 ADA fee on 10 ADA sent: invisible to the flat cap, 20% of the send —
      // and only 0.2 ADA of it is the protocol's own linear fee.
      const r = await review(
        buildBody({fee: 2_000_000n}),
        ownInput(20_000_000n),
        breakdown({linear: 200_000n, scriptExecution: 1_800_000n, total: 2_000_000n, sentCoin: 10_000_000n}),
      )
      expect(r.warnings).toContain('large-fee')
    })

    it('does not flag a minimum-fee small send, whatever the ratio', async () => {
      // The real-world false positive: 0.170561 ADA on 1.5 ADA sent is 11.4%, over
      // the 10% threshold — but that fee IS `linear`, the cheapest the chain
      // accepts. A Cardano fee tracks size, not the amount sent, so every small
      // send would carry an "unusually large fee" warning.
      const r = await review(
        buildBody({fee: 170_561n}),
        ownInput(20_000_000n),
        breakdown({linear: 170_561n, total: 170_561n, sentCoin: 1_500_000n}),
      )
      expect(r.warnings).not.toContain('large-fee')
    })

    it('still flags an absolutely large fee even at the protocol minimum', async () => {
      // The flat cap is independent of the ratio gate: 6 ADA is worth stating
      // however it arose.
      const r = await review(
        buildBody({fee: 6_000_000n}),
        ownInput(20_000_000n),
        breakdown({linear: 6_000_000n, total: 6_000_000n, sentCoin: 10_000_000n}),
      )
      expect(r.warnings).toContain('large-fee')
    })

    it('leaves an ordinary fee unflagged', async () => {
      const r = await review(buildBody({fee: 200_000n}), ownInput(20_000_000n), breakdown({sentCoin: 10_000_000n}))
      expect(r.warnings).not.toContain('large-fee')
      expect(r.warnings).not.toContain('change-folded-into-fee')
    })

    it('warns separately when change was folded into the fee', async () => {
      const r = await review(
        buildBody({fee: 400_000n}),
        ownInput(20_000_000n),
        breakdown({total: 400_000n, foldedFromChange: 200_000n}),
      )
      expect(r.warnings).toContain('change-folded-into-fee')
    })

    it('keeps the flat cap when no breakdown is supplied (dApp-built tx)', async () => {
      const r = await review(buildBody({fee: LARGE_FEE_LOVELACE + 1n}), ownInput(10_000_000n))
      expect(r.warnings).toContain('large-fee')
      // Nothing to fold-check against, so no false alarm.
      expect(r.warnings).not.toContain('change-folded-into-fee')
    })

    it('does not divide by zero when nothing is sent (staking-only tx)', async () => {
      const r = await review(
        buildBody({fee: 300_000n}),
        ownInput(20_000_000n),
        breakdown({total: 300_000n, sentCoin: 0n}),
      )
      expect(r.warnings).not.toContain('large-fee')
    })
  })

  it('reports an own withdrawal as an operation, and counts its proceeds once', async () => {
    // A balanced withdrawal: 1.0 in + 0.5 withdrawn = 1.3 out + 0.2 fee. The rewards arrive in the
    // output, so the delta is already 0.3 — withdrawal minus fee. Adding the 0.5 on top of that
    // reported 0.8, and on the first real Eternl request 18.15 tADA for a 9.16 tADA withdrawal.
    const bodyHex = buildBody({
      withdrawals: [{rewardAcctHex: fx.rewardAcctHex, amount: 500_000n}],
      outputs: [{addressHex: fx.ownAddrHex, coin: 1_300_000n}],
    })
    const r = await review(bodyHex)
    const withdrawal = r.operations.find((op) => op.kind === 'reward-withdrawal')
    expect(withdrawal).toMatchObject({kind: 'reward-withdrawal', amount: 500_000n, own: true})
    expect(r.ownDelta).toEqual([{quantity: 500_000n - r.fee}])
    expect(r.ownDelta).toEqual([{quantity: 300_000n}])
  })

  // Eternl's multi-delegation shape: our payment key parked under a stake key we do not manage, so
  // we can spend it but its delegation is not ours. Change goes to `external[0]` by decision, which
  // silently re-homes those coins under our own stake key — the review is the only place that shows.
  describe('ends-external-delegation', () => {
    const multiDelegationInput = (coin: bigint): ResolvedInput => ({
      txHashHex: OWN_UTXO_HASH,
      index: 0,
      addressHex: fx.multiDelegationAddrHex,
      coin,
      tokens: [],
    })

    it('warns when the coins move to our own address and nothing goes back', async () => {
      const bodyHex = buildBody({outputs: [{addressHex: fx.ownAddrHex, coin: 800_000n}]})
      const r = await review(bodyHex, multiDelegationInput(1_000_000n))
      expect(r.warnings).toContain('ends-external-delegation')
    })

    it('stays quiet when an output returns to the same stake credential', async () => {
      const bodyHex = buildBody({outputs: [{addressHex: fx.multiDelegationAddrHex, coin: 800_000n}]})
      const r = await review(bodyHex, multiDelegationInput(1_000_000n))
      expect(r.warnings).not.toContain('ends-external-delegation')
    })

    // An ordinary send off the primary address has no delegation to end, and a warning that fires
    // on ordinary sends is one nobody reads by the time it matters.
    it('stays quiet on a plain send from our own address', async () => {
      const bodyHex = buildBody({outputs: [{addressHex: fx.otherAddrHex, coin: 800_000n}]})
      const r = await review(bodyHex)
      expect(r.warnings).not.toContain('ends-external-delegation')
    })

    // The input is still ours: we hold the payment key, so it must not read as a counterparty.
    it('still classifies the input as the wallet spending its own coins', async () => {
      const bodyHex = buildBody({outputs: [{addressHex: fx.ownAddrHex, coin: 800_000n}]})
      const r = await review(bodyHex, multiDelegationInput(1_000_000n))
      expect(r.inputs[0]?.ownership).toEqual({level: 'own', owner: 'wallet'})
      expect(r.warnings).not.toContain('stake-credential-reuse')
    })
  })

  // The corollary of folding multi-delegation addresses into `ownGroup`: spendability follows the
  // payment credential, but staking follows the stake credential, and the wallet must never claim a
  // reward or a delegation it cannot control.
  it('does not claim a withdrawal drawn on a stake credential it does not manage', async () => {
    const bodyHex = buildBody({
      withdrawals: [{rewardAcctHex: fx.otherRewardAcctHex, amount: 500_000n}],
      outputs: [{addressHex: fx.ownAddrHex, coin: 1_300_000n}],
    })
    const r = await review(bodyHex)
    const withdrawal = r.operations.find((op) => op.kind === 'reward-withdrawal')
    expect(withdrawal).toMatchObject({kind: 'reward-withdrawal', amount: 500_000n, own: false})
    // Someone else's rewards funding an output of ours is a receipt, not a withdrawal we made:
    // the delta is what actually landed, with the 500k in it exactly once via the output.
    expect(r.ownDelta).toEqual([{quantity: 300_000n}])
  })

  it('extracts a stake delegation with its pool key hash', async () => {
    const bodyHex = buildBody({certHexes: [await cert1(Certs.stakeDelegation(fx.stakeKeyHash, '33'.repeat(28)))]})
    const r = await review(bodyHex)
    const op = r.operations.find((o) => o.kind === 'stake-delegation')
    expect(op).toMatchObject({kind: 'stake-delegation', poolKeyHashHex: '33'.repeat(28)})
    if (op?.kind === 'stake-delegation') expect(op.credential.hashHex).toBe(fx.stakeKeyHash)
  })

  it('extracts a vote delegation with its DRep target', async () => {
    const bodyHex = buildBody({certHexes: [await cert1(Certs.voteDelegation(fx.stakeKeyHash, 'key', '44'.repeat(28)))]})
    const r = await review(bodyHex)
    const op = r.operations.find((o) => o.kind === 'vote-delegation')
    expect(op?.kind === 'vote-delegation' && op.drep).toEqual({type: 'key_hash', keyHashHex: '44'.repeat(28)})
  })
})

describe('deposit sourcing (Fallback Value Policy — never a blanket 2 ADA)', () => {
  it('legacy stake registration → protocol keyDeposit', async () => {
    const bodyHex = buildBody({certHexes: [await cert1(Certs.stakeRegistration(fx.stakeKeyHash))]})
    const r = await review(bodyHex)
    const op = r.operations.find((o) => o.kind === 'stake-registration')
    expect(op?.kind === 'stake-registration' && op.deposit).toBe(PARAMS.keyDeposit)
  })

  it('Conway reg cert → the cert’s own deposit field (not a param)', async () => {
    const bodyHex = buildBody({certHexes: [await cert1(Certs.registration(fx.stakeKeyHash, 3_000_000n))]})
    const r = await review(bodyHex)
    const op = r.operations.find((o) => o.kind === 'stake-registration')
    expect(op?.kind === 'stake-registration' && op.deposit).toBe(3_000_000n)
  })

  it('DRep registration → the cert’s deposit field (500 ADA, not 2 ADA)', async () => {
    const bodyHex = buildBody({certHexes: [await cert1(Certs.drepRegistration(fx.stakeKeyHash, 500_000_000n))]})
    const r = await review(bodyHex)
    const op = r.operations.find((o) => o.kind === 'drep-registration')
    expect(op?.kind === 'drep-registration' && op.deposit).toBe(500_000_000n)
  })
})

describe('governance vote extraction', () => {
  it('extracts the vote choice + gov-action id from voting procedures', async () => {
    const votingHex = await run(
      Effect.gen(function* () {
        const voter = yield* Gov.voterDrep(fx.stakeKeyHash)
        const gaid = yield* Gov.govActionId(TxHashHex('55'.repeat(32)), 2n)
        const vp = yield* Gov.votingProcedure(Gov.Vote.Yes)
        return yield* Gov.votingProcedures([voter], [gaid], [vp])
      }).pipe(Effect.provide(testLayer)),
    )
    const r = await review(buildBody({bodyExtra: [[19, votingHex]]}))
    const op = r.operations.find((o) => o.kind === 'voting-procedures')
    expect(op?.kind).toBe('voting-procedures')
    if (op?.kind !== 'voting-procedures') return
    expect(op.votes).toHaveLength(1)
    expect(op.votes[0]?.choice).toBe('yes')
    expect(op.votes[0]?.govActionId).toEqual({txHashHex: '55'.repeat(32), index: 2})
    expect(op.votes[0]?.voter).toEqual({role: 'drep', credential: {hashHex: fx.stakeKeyHash, type: 'key'}})
    expect(r.warnings).toContain('governance-action')
  })
})

describe('resolveCardanoSigningPaths', () => {
  const registry = () => [
    {keyHashHex: fx.paymentKeyHash, path: PAYMENT_PATH},
    {keyHashHex: fx.stakeKeyHash, path: STAKE_PATH},
  ]

  it('resolves the payment path from resolved inputs', async () => {
    const resolved = await run(
      resolveCardanoSigningPaths(buildBody({}), registry(), [ownInput(1_000_000n)]).pipe(Effect.provide(testLayer)),
    )
    expect(resolved.signingPaths).toEqual([PAYMENT_PATH])
    expect(resolved.requiredKeyHashes).toEqual([fx.paymentKeyHash])
  })

  it('adds the stake path for certificates and withdrawals', async () => {
    const bodyHex = buildBody({
      certHexes: [await cert1(Certs.stakeDelegation(fx.stakeKeyHash, '33'.repeat(28)))],
      withdrawals: [{rewardAcctHex: fx.rewardAcctHex, amount: 1n}],
    })
    const resolved = await run(
      resolveCardanoSigningPaths(bodyHex, registry(), [ownInput(1_000_000n)]).pipe(Effect.provide(testLayer)),
    )
    expect(resolved.signingPaths).toEqual([PAYMENT_PATH, STAKE_PATH])
    expect(new Set(resolved.requiredKeyHashes)).toEqual(new Set([fx.paymentKeyHash, fx.stakeKeyHash]))
  })

  it('resolves nothing from a script input on its own', async () => {
    // A script address's payment credential is a script hash, so there is no key
    // to require and the leaves the script names are unknowable from the address.
    // Without a script authority a script spend goes out unsigned.
    const scriptInput: ResolvedInput = {
      txHashHex: OWN_UTXO_HASH,
      index: 0,
      addressHex: fx.scriptAddrHex,
      coin: 1_000_000n,
      tokens: [],
    }
    const resolved = await run(
      resolveCardanoSigningPaths(buildBody({}), registry(), [scriptInput]).pipe(Effect.provide(testLayer)),
    )
    expect(resolved.signingPaths).toEqual([])
  })

  it('resolves our own path once the script names it', async () => {
    const scriptInput: ResolvedInput = {
      txHashHex: OWN_UTXO_HASH,
      index: 0,
      addressHex: fx.scriptAddrHex,
      coin: 1_000_000n,
      tokens: [],
    }
    const resolved = await run(
      resolveCardanoSigningPaths(
        buildBody({}),
        registry(),
        [scriptInput],
        [
          {
            scriptHashHex: '99'.repeat(28),
            signerKeyHashes: [fx.paymentKeyHash],
          },
        ],
      ).pipe(Effect.provide(testLayer)),
    )
    expect(resolved.signingPaths).toEqual([PAYMENT_PATH])
    expect(resolved.requiredKeyHashes).toContain(fx.paymentKeyHash)
  })

  it('reports a co-signer leaf we cannot sign for, without a path', async () => {
    const otherLeaf = '77'.repeat(28)
    const resolved = await run(
      resolveCardanoSigningPaths(
        buildBody({}),
        registry(),
        [ownInput(1_000_000n)],
        [
          {
            scriptHashHex: '99'.repeat(28),
            signerKeyHashes: [otherLeaf],
          },
        ],
      ).pipe(Effect.provide(testLayer)),
    )
    expect(resolved.requiredKeyHashes).toContain(otherLeaf)
    expect(resolved.signingPaths).toEqual([PAYMENT_PATH])
  })

  it('leaves an ordinary wallet unchanged when the script authority is omitted', async () => {
    const withArg = await run(
      resolveCardanoSigningPaths(
        buildBody({}),
        registry(),
        [ownInput(1_000_000n)],
        [
          {
            scriptHashHex: '99'.repeat(28),
            signerKeyHashes: [],
          },
        ],
      ).pipe(Effect.provide(testLayer)),
    )
    const without = await run(
      resolveCardanoSigningPaths(buildBody({}), registry(), [ownInput(1_000_000n)]).pipe(Effect.provide(testLayer)),
    )
    expect(withArg).toEqual(without)
  })

  it('reports foreign required signers it cannot map to paths', async () => {
    const foreignStake = '44'.repeat(28)
    const bodyHex = buildBody({certHexes: [await cert1(Certs.stakeDelegation(foreignStake, '33'.repeat(28)))]})
    const resolved = await run(
      resolveCardanoSigningPaths(bodyHex, registry(), [ownInput(1_000_000n)]).pipe(Effect.provide(testLayer)),
    )
    expect(resolved.signingPaths).toEqual([PAYMENT_PATH])
    expect(resolved.requiredKeyHashes).toContain(foreignStake)
  })
})

describe('a script-credential certificate — whose script it is decides the warning', () => {
  const OUR_STAKE_SCRIPT = 'de'.repeat(28)
  const THEIR_SCRIPT = 'fa'.repeat(28)

  const reviewAs = (bodyHex: string, context: WalletContext) =>
    run(reviewCardanoTx(bodyHex, context, [ownInput(1_000_000n)], PARAMS).pipe(Effect.provide(testLayer)))

  /** A shared wallet: its stake credential is a script, and it knows that. */
  const sharedContext = (): WalletContext => ({
    paymentKeyHashes: new Set<string>(),
    paymentScriptHashes: new Set([fx.paymentKeyHash]),
    stakeKeyHashHex: OUR_STAKE_SCRIPT,
    stakeIsScript: true,
  })

  it('says nothing about the wallet delegating its own script', async () => {
    const bodyHex = buildBody({
      certHexes: [await cert1(Certs.stakeDelegation(OUR_STAKE_SCRIPT, '33'.repeat(28), true))],
    })
    expect((await reviewAs(bodyHex, sharedContext())).warnings).not.toContain('script-certificate')
  })

  it('still warns when the script is somebody else’s', async () => {
    // This is what the warning is for, and it has to survive the case above:
    // suppressing it wholesale would remove the only notice that a credential
    // this wallet does not control is being acted on.
    const bodyHex = buildBody({
      certHexes: [await cert1(Certs.stakeDelegation(THEIR_SCRIPT, '33'.repeat(28), true))],
    })
    expect((await reviewAs(bodyHex, sharedContext())).warnings).toContain('script-certificate')
  })

  it('warns a key wallet about any script certificate, including that hash', async () => {
    // A key wallet's `stakeKeyHashHex` is a key hash, so no script credential is
    // ever its own — `stakeIsScript` absent must not be read as "everything is
    // mine".
    const bodyHex = buildBody({
      certHexes: [await cert1(Certs.stakeDelegation(OUR_STAKE_SCRIPT, '33'.repeat(28), true))],
    })
    expect((await reviewAs(bodyHex, fx.context)).warnings).toContain('script-certificate')
  })
})
