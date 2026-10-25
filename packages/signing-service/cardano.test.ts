import {Assets, Bytes, Address as EvAddress, Assets as EvAssets, TransactionBody, TxOut} from '@evolution-sdk/evolution'
import {Plan} from '@evolution-sdk/plan'
import {type AddressHex, type KeyHashHex, TxHashHex, XprvHex, XpubHex} from '@evolution-sdk/review/Brands'
import {Address, Cose, Keys, Tx, Wallet} from '@pnyx/cardano-core'
import {asSecretText, type SecretText} from '@pnyx/crypto'
import {Effect, Layer} from 'effect'
import {beforeAll, describe, expect, it} from 'vitest'
import {signCardanoData, signCardanoTx} from './cardano.js'
import {
  type Broadcaster,
  BroadcasterTag,
  type CardanoTxContext,
  CardanoTxContextTag,
  type CredentialStore,
  CredentialStoreTag,
  type HardwareBackend,
  HardwareBackendTag,
} from './ports.js'
import {SigningServiceLayer, SigningServiceTag} from './service.js'
import {
  type CardanoDataPayload,
  type CardanoTxPayload,
  SigningDeviceError,
  type SigningProgress,
  type SigningRequest,
  SigningSequenceError,
} from './types.js'

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const PAYMENT_PATH = "m/1852'/1815'/0'/0/0"
const STAKE_PATH = "m/1852'/1815'/0'/2/0"
const GROUP = 'group-1'

type Fixture = {
  readonly rootXprv: SecretText
  readonly bodyHex: string
  readonly bodyHashHex: string
  readonly addrHex: AddressHex
  readonly paymentXprv: XprvHex
  readonly paymentVkey: string
  readonly paymentKeyHash: KeyHashHex
  readonly accountXpub: XpubHex
}

let fx: Fixture

beforeAll(async () => {
  fx = await Effect.runPromise(
    Effect.gen(function* () {
      const account = yield* Wallet.fromMnemonic(MNEMONIC, 0)
      const addrBech = yield* account.baseAddress(Address.Network.Testnet)
      const addrHex = Address.fromBech32Sync(addrBech)
      const input = Tx.inputHex(TxHashHex('11'.repeat(32)), 0n)
      // ⚠️ `encodingFormat: 'babbage'`, the shape the wallet emits.
      const output = TxOut.toCBORBytes(
        new TxOut.TransactionOutput({
          address: EvAddress.fromHex(addrHex),
          assets: Assets.fromLovelace(1_000_000n),
          encodingFormat: 'babbage',
        }),
      )
      const bodyHex = TransactionBody.toCBORHex(
        TransactionBody.fromEncoded({inputs: [Bytes.fromHex(input)], outputs: [output], fee: 200_000n}),
      )
      const paymentXprv = yield* account.paymentKey()
      const paymentVkey = Keys.publicKeySync(paymentXprv)
      const HARDENED = 0x80000000
      const acctKey = yield* Keys.derivePath(account.rootXprv, [
        (1852 | HARDENED) >>> 0,
        (1815 | HARDENED) >>> 0,
        HARDENED,
      ])
      return {
        rootXprv: asSecretText(account.rootXprv),
        bodyHex,
        bodyHashHex: Tx.bodyHash(bodyHex),
        addrHex,
        paymentXprv,
        paymentVkey,
        paymentKeyHash: Keys.keyHashSync(paymentVkey),
        accountXpub: XpubHex(Keys.publicKeySync(acctKey) + acctKey.slice(-64)),
      }
    }),
  )
})

const softwareCredentials: CredentialStore = {
  resolve: () => Effect.succeed({kind: 'software', rootXprvHex: fx.rootXprv}),
}

const txContext = (requiredKeyHashes?: readonly string[]): CardanoTxContext => ({
  resolveSigningPaths: () =>
    Effect.succeed({signingPaths: [PAYMENT_PATH], requiredKeyHashes: requiredKeyHashes ?? [fx.paymentKeyHash]}),
})

const recordingBroadcaster = (): Broadcaster & {readonly sent: string[]} => {
  const sent: string[] = []
  return {
    sent,
    broadcast: (_chain, signedTxHex) => {
      sent.push(signedTxHex)
      return Effect.succeed(Tx.bodyHashOfSigned(signedTxHex))
    },
  }
}

const unusedHardware: HardwareBackend = {
  ensureReady: () => Effect.die('hardware must not be touched'),
  getAccountExtendedPublicKey: () => Effect.die('hardware must not be touched'),
  signCardanoTx: () => Effect.die('hardware must not be touched'),
  signCardanoMessage: () => Effect.die('hardware must not be touched'),
}

const deps = (overrides?: {
  credentials?: CredentialStore
  hardware?: HardwareBackend
  broadcaster?: Broadcaster
  context?: CardanoTxContext
}) => ({
  credentials: overrides?.credentials ?? softwareCredentials,
  hardware: overrides?.hardware ?? unusedHardware,
  broadcaster: overrides?.broadcaster ?? recordingBroadcaster(),
  txContext: overrides?.context ?? txContext(),
})

const txPayload = (overrides?: Partial<CardanoTxPayload>): CardanoTxPayload => ({
  _tag: 'CardanoTx',
  bodyHex: fx.bodyHex,
  networkId: 0,
  ...overrides,
})

const txRequest = (payload: CardanoTxPayload = txPayload()): SigningRequest => ({groupId: GROUP, payload})

describe('buildPlanUnsigned → signing-service byte parity', () => {
  it('reproduces buildPlan output exactly when the service signs the unsigned build', async () => {
    const params = {
      minFeeA: 44n,
      minFeeB: 155_381n,
      coinsPerUtxoByte: 4_310n,
      keyDeposit: 2_000_000n,
      poolDeposit: 500_000_000n,
      drepDeposit: 500_000_000n,
    }
    const planInputs = [{txHash: TxHashHex('11'.repeat(32)), index: 0, assets: EvAssets.fromLovelace(5_000_000n)}]
    const outputs = [{addressHex: fx.addrHex, assets: EvAssets.fromLovelace(1_000_000n)}]
    const shared = {inputs: planInputs, outputs, changeAddressHex: fx.addrHex, params, ttl: 99_000_000}
    const signed = Plan.build({...shared, signers: [fx.paymentXprv]})
    const unsigned = Plan.buildUnsigned({...shared, signerCount: 1})
    expect(unsigned.bodyHex).toBe(signed.bodyHex)
    expect(unsigned.fee).toBe(signed.fee)

    const payload = txPayload({bodyHex: unsigned.bodyHex, ...(unsigned.auxHex ? {auxHex: unsigned.auxHex} : {})})
    const broadcaster = recordingBroadcaster()
    const result = await Effect.runPromise(
      signCardanoTx(
        deps({
          broadcaster,
          context: {
            resolveSigningPaths: () =>
              Effect.succeed({signingPaths: [PAYMENT_PATH], requiredKeyHashes: [fx.paymentKeyHash]}),
          },
        }),
        txRequest(payload),
        payload,
      ),
    )
    expect(result._tag).toBe('TxSubmitted')
    if (result._tag !== 'TxSubmitted') return
    expect(result.signedTxHex).toBe(signed.signedTxHex)
  })
})

describe('signCardanoTx — software', () => {
  it('signs and broadcasts an assembled tx', async () => {
    const broadcaster = recordingBroadcaster()
    const payload = txPayload()
    const result = await Effect.runPromise(signCardanoTx(deps({broadcaster}), txRequest(payload), payload))
    expect(result._tag).toBe('TxSubmitted')
    if (result._tag !== 'TxSubmitted') return
    expect(result.txHash).toBe(fx.bodyHashHex)
    expect(broadcaster.sent).toHaveLength(1)
    expect(result.signedTxHex).toContain(fx.bodyHex)
    expect(result.signedTxHex).toContain(fx.paymentVkey)
  })

  it('signOnly returns a witness set and never broadcasts', async () => {
    const broadcaster = recordingBroadcaster()
    const payload = txPayload({signOnly: true})
    const result = await Effect.runPromise(signCardanoTx(deps({broadcaster}), txRequest(payload), payload))
    expect(result._tag).toBe('TxSignedOnly')
    if (result._tag !== 'TxSignedOnly') return
    expect(result.witnessSetHex).toContain(fx.paymentVkey)
    expect(broadcaster.sent).toHaveLength(0)
  })

  it('fails with SigningWitnessError when required hashes are not covered', async () => {
    const foreign = 'ff'.repeat(28)
    const error = await Effect.runPromise(
      Effect.flip(signCardanoTx(deps({context: txContext([fx.paymentKeyHash, foreign])}), txRequest(), txPayload())),
    )
    expect(error._tag).toBe('SigningWitnessError')
    if (error._tag !== 'SigningWitnessError') return
    expect(error.missingKeyHashes).toEqual([foreign])
  })

  it('partial skips the coverage check', async () => {
    const payload = txPayload({partial: true, signOnly: true})
    const result = await Effect.runPromise(
      signCardanoTx(deps({context: txContext(['ff'.repeat(28)])}), txRequest(payload), payload),
    )
    expect(result._tag).toBe('TxSignedOnly')
  })

  it('fails with SigningPayloadError when no signing paths resolve', async () => {
    const empty: CardanoTxContext = {
      resolveSigningPaths: () => Effect.succeed({signingPaths: [], requiredKeyHashes: []}),
    }
    const error = await Effect.runPromise(Effect.flip(signCardanoTx(deps({context: empty}), txRequest(), txPayload())))
    expect(error._tag).toBe('SigningPayloadError')
  })

  it('reports progress phases in order', async () => {
    const phases: SigningProgress['phase'][] = []
    await Effect.runPromise(
      signCardanoTx(deps(), txRequest(), txPayload(), (p) => {
        phases.push(p.phase)
      }),
    )
    expect(phases).toEqual(['resolving-keys', 'signing', 'assembling', 'submitting'])
  })
})

describe('signCardanoTx — hardware', () => {
  const hardwareCredentials = (accountXpubHex?: string): CredentialStore => ({
    resolve: () =>
      Effect.succeed({
        kind: 'hardware',
        deviceType: 'ledger',
        ...(accountXpubHex !== undefined ? {accountXpubHex} : {}),
      }),
  })

  const signingDevice = (): HardwareBackend => ({
    ensureReady: () => Effect.void,
    getAccountExtendedPublicKey: () => Effect.succeed(fx.accountXpub),
    signCardanoTx: (request) =>
      Effect.succeed([
        {
          publicKeyHashHex: fx.paymentKeyHash,
          publicKeyHex: fx.paymentVkey,
          signatureHex: Keys.signSync(fx.paymentXprv, request.txBodyHashHex),
        },
      ]),
    signCardanoMessage: () => Effect.die('not a message test'),
  })

  it('signs via the device and broadcasts', async () => {
    const broadcaster = recordingBroadcaster()
    const result = await Effect.runPromise(
      signCardanoTx(
        deps({credentials: hardwareCredentials(fx.accountXpub), hardware: signingDevice(), broadcaster}),
        txRequest(),
        txPayload(),
      ),
    )
    expect(result._tag).toBe('TxSubmitted')
    expect(broadcaster.sent).toHaveLength(1)
  })

  it('rejects a device whose account key does not match', async () => {
    const wrongXpub = 'aa'.repeat(64)
    const error = await Effect.runPromise(
      Effect.flip(
        signCardanoTx(
          deps({credentials: hardwareCredentials(wrongXpub), hardware: signingDevice()}),
          txRequest(),
          txPayload(),
        ),
      ),
    )
    expect(error).toBeInstanceOf(SigningDeviceError)
    if (!(error instanceof SigningDeviceError)) return
    expect(error.reason).toMatch(/does not match/)
  })

  it('rejects a device witness whose signature does not cover the reviewed body (blind-signing guard)', async () => {
    const malicious: HardwareBackend = {
      ...signingDevice(),
      signCardanoTx: () =>
        Effect.succeed([
          {
            publicKeyHashHex: fx.paymentKeyHash,
            publicKeyHex: fx.paymentVkey,
            // A valid signature, but over a DIFFERENT body hash than the one the
            // user reviewed — the exact attack the verification closes.
            signatureHex: Keys.signSync(fx.paymentXprv, 'ab'.repeat(32)),
          },
        ]),
    }
    const error = await Effect.runPromise(
      Effect.flip(
        signCardanoTx(
          deps({credentials: hardwareCredentials(fx.accountXpub), hardware: malicious}),
          txRequest(),
          txPayload(),
        ),
      ),
    )
    expect(error._tag).toBe('SigningWitnessError')
    if (error._tag !== 'SigningWitnessError') return
    expect(error.reason).toMatch(/does not sign the reviewed transaction body/)
  })

  it('fails closed on a malformed device signature', async () => {
    const malformed: HardwareBackend = {
      ...signingDevice(),
      signCardanoTx: () =>
        Effect.succeed([{publicKeyHashHex: fx.paymentKeyHash, publicKeyHex: fx.paymentVkey, signatureHex: 'zz'}]),
    }
    const error = await Effect.runPromise(
      Effect.flip(
        signCardanoTx(
          deps({credentials: hardwareCredentials(fx.accountXpub), hardware: malformed}),
          txRequest(),
          txPayload(),
        ),
      ),
    )
    expect(error._tag).toBe('SigningWitnessError')
  })

  it('skips identity verification when no xpub was recorded', async () => {
    const device = {
      ...signingDevice(),
      getAccountExtendedPublicKey: () => Effect.die('must not be called without a recorded xpub'),
    }
    const payload = txPayload({signOnly: true})
    const result = await Effect.runPromise(
      signCardanoTx(deps({credentials: hardwareCredentials(), hardware: device}), txRequest(payload), payload),
    )
    expect(result._tag).toBe('TxSignedOnly')
  })
})

describe('signCardanoData', () => {
  const dataPayload = (signingPath: string): CardanoDataPayload => ({
    _tag: 'CardanoData',
    addressHex: fx.addrHex,
    payloadHex: Buffer.from('pnyx hello', 'utf8').toString('hex'),
    signingPath,
    networkId: 0,
  })

  const dataRequest = (payload: CardanoDataPayload): SigningRequest => ({groupId: GROUP, payload})

  it('software: signs and the envelope verifies', async () => {
    const payload = dataPayload(PAYMENT_PATH)
    const result = await Effect.runPromise(signCardanoData(deps(), dataRequest(payload), payload))
    expect(result._tag).toBe('DataSigned')
    if (result._tag !== 'DataSigned') return
    const valid = await Effect.runPromise(Cose.verifyData({signature: result.signature, key: result.key}))
    expect(valid).toBe(true)
  })

  it('verifyData rejects a valid signature whose key does not own the claimed address (M-01 forgery)', async () => {
    const HARDENED = 0x80000000
    const payloadHex = Buffer.from('pnyx hello', 'utf8').toString('hex')
    const valid = await Effect.runPromise(
      Effect.gen(function* () {
        // A well-formed key that is NOT in fx.addrHex (payment /0/0, stake /2/0).
        const foreignXprv = yield* Keys.derivePath(XprvHex(fx.rootXprv), [
          (1852 | HARDENED) >>> 0,
          (1815 | HARDENED) >>> 0,
          HARDENED,
          0,
          1,
        ])
        // Sign with the foreign key but claim ownership of fx.addrHex.
        const forged = yield* Cose.signData(foreignXprv, fx.addrHex, payloadHex, true)
        return yield* Cose.verifyData({signature: forged.signature, key: forged.key})
      }),
    )
    expect(valid).toBe(false)
  })

  it('software: rejects a signing path that does not match the address credential', async () => {
    const payload = dataPayload(STAKE_PATH)
    const error = await Effect.runPromise(Effect.flip(signCardanoData(deps(), dataRequest(payload), payload)))
    expect(error._tag).toBe('SigningPayloadError')
  })

  // ⚠️ The ownership check used to be conditional on a credential being readable, and a Byron
  // address has none — `Address.inspect` reports `kind: 'byron'` with neither `paymentCredHex`
  // nor `stakeCredHex`, so `target` was `undefined` and the comparison was skipped entirely. The
  // address comes from the dApp's `signData` request, so that was a caller-chosen way past the
  // one check standing between a request and a signature claiming an address we may not own.
  it('software: refuses an address whose credential cannot be read, rather than skipping the check', async () => {
    const byronAddressHex = `82${'11'.repeat(28)}`
    const payload = {...dataPayload(PAYMENT_PATH), addressHex: byronAddressHex}
    const error = await Effect.runPromise(Effect.flip(signCardanoData(deps(), dataRequest(payload), payload)))
    expect(error._tag).toBe('SigningPayloadError')
    expect(String((error as {reason?: string}).reason)).toContain('credential')
  })

  it('hardware: assembles a verifying KEY_HASH-mode envelope from a device signature', async () => {
    const payload = dataPayload(PAYMENT_PATH)
    const device: HardwareBackend = {
      ensureReady: () => Effect.void,
      getAccountExtendedPublicKey: () => Effect.succeed(fx.accountXpub),
      signCardanoTx: () => Effect.die('not a tx test'),
      signCardanoMessage: (msg) =>
        Effect.gen(function* () {
          // A faithful device: sign the KEY_HASH-mode Sig_structure (address
          // header = blake2b-224(pubkey), no kid) with the path's key.
          // KEY_HASH mode puts the 28-byte key hash in the COSE `address` header, not an
          // address — which `CoseAddressHeader` admits directly, no assertion needed.
          const envelope = yield* Cose.signData(fx.paymentXprv, fx.paymentKeyHash, msg.payloadHex, false)
          return {
            signature: Buffer.from(envelope.signature.slice(-128), 'hex'),
            publicKey: Buffer.from(fx.paymentVkey, 'hex'),
            derivationPath: msg.signingPath,
          }
        }).pipe(Effect.orDie),
    }
    const hardwareCreds: CredentialStore = {
      resolve: () => Effect.succeed({kind: 'hardware', deviceType: 'trezor'}),
    }
    const result = await Effect.runPromise(
      signCardanoData(deps({credentials: hardwareCreds, hardware: device}), dataRequest(payload), payload),
    )
    expect(result._tag).toBe('DataSigned')
    if (result._tag !== 'DataSigned') return
    const valid = await Effect.runPromise(Cose.verifyData({signature: result.signature, key: result.key}))
    expect(valid).toBe(true)
  })
})

describe('SigningService layer — signAll', () => {
  const serviceLayer = (broadcaster: Broadcaster, context?: CardanoTxContext) =>
    SigningServiceLayer.pipe(
      Layer.provide(Layer.succeed(CredentialStoreTag, softwareCredentials)),
      Layer.provide(Layer.succeed(HardwareBackendTag, unusedHardware)),
      Layer.provide(Layer.succeed(BroadcasterTag, broadcaster)),
      Layer.provide(Layer.succeed(CardanoTxContextTag, context ?? txContext())),
    )

  it('runs legs sequentially, in order', async () => {
    const broadcaster = recordingBroadcaster()
    const results = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* SigningServiceTag
        return yield* service.signAll([txRequest(), txRequest()])
      }).pipe(Effect.provide(serviceLayer(broadcaster))),
    )
    expect(results).toHaveLength(2)
    expect(broadcaster.sent).toHaveLength(2)
  })

  it('stops on the first failure and reports completed legs', async () => {
    const broadcaster = recordingBroadcaster()
    let calls = 0
    const flaky: CardanoTxContext = {
      resolveSigningPaths: () => {
        calls++
        return calls === 1
          ? Effect.succeed({signingPaths: [PAYMENT_PATH], requiredKeyHashes: [fx.paymentKeyHash]})
          : Effect.succeed({signingPaths: [PAYMENT_PATH], requiredKeyHashes: ['ff'.repeat(28)]})
      },
    }
    const error = await Effect.runPromise(
      Effect.flip(
        Effect.gen(function* () {
          const service = yield* SigningServiceTag
          return yield* service.signAll([txRequest(), txRequest(), txRequest()])
        }).pipe(Effect.provide(serviceLayer(broadcaster, flaky))),
      ),
    )
    expect(error).toBeInstanceOf(SigningSequenceError)
    if (!(error instanceof SigningSequenceError)) return
    expect(error.failedIndex).toBe(1)
    expect(error.completed).toHaveLength(1)
    expect(error.failure._tag).toBe('SigningWitnessError')
    expect(broadcaster.sent).toHaveLength(1)
  })

  it('getSignerKind reflects the resolved credential', async () => {
    const kind = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* SigningServiceTag
        return yield* service.getSignerKind(GROUP)
      }).pipe(Effect.provide(serviceLayer(recordingBroadcaster()))),
    )
    expect(kind).toBe('software')
  })
})
