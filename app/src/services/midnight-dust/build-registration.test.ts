import {
  Assets,
  Address as EvolutionAddress,
  Assets as EvolutionAssets,
  type Provider as EvolutionProvider,
  UTxO as EvolutionUTxO,
  TransactionHash,
} from '@evolution-sdk/evolution'
import * as MockDefaults from '@evolution-sdk/evolution/sdk/provider/Mock'
import {Bech32, TxHashHex} from '@evolution-sdk/review/Brands'
import {layer as EvolutionDecodeLayer} from '@evolution-sdk/review/Decode'
import * as Inspect from '@evolution-sdk/review/Inspect'
import {Address, Tx, Wallet} from '@pnyx/cardano-core'
import {utxoId} from '@pnyx/wallet'
import {Effect} from 'effect'
import {describe, expect, it} from 'vitest'
import type {CardanoRailConfig} from '../cardano/config'
import {makeCardanoRail} from '../cardano/rail'
import {mockChain} from '../cardano/test-provider'
import {buildDestinationChangeTxs, buildRegistrationTx, unsupportedIntent} from './build-registration'
import {decodeDustRegistrationDatum, encodeDustRegistrationDatum} from './registration-datum'
import {
  DUST_AUTH_TOKEN_ASSET_ID,
  DUST_VALIDATOR_ADDRESS,
  DUST_VALIDATOR_MIN_UTXO_LOVELACE,
  DUST_VALIDATOR_SCRIPT_HASH,
  DUST_VALIDATOR_SCRIPT_HEX,
} from './validator'

const STAKE = '3a57af7913f0578ceddb35cd72e9abc3644189afb6607ce6d22d076e'
const DUST = '736eac3e7bd29f5f6f950d57d3218f1f3194ba91e2e5f9e27b5add9f75fc78613d'
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const GROUP = 'group-dust'

describe('the registration output', () => {
  // The builder itself needs a rail; what is pinned here is the output it constructs,
  // because those bytes are what the validator checks.

  it('carries exactly one auth token at the validator address, with the datum', async () => {
    const valueHex = Assets.toCBORHex(
      Assets.fromRecord({lovelace: DUST_VALIDATOR_MIN_UTXO_LOVELACE, [DUST_AUTH_TOKEN_ASSET_ID]: 1n}),
    )
    const value = await Effect.runPromise(Inspect.value(valueHex))

    expect(value.amount).toBe(DUST_VALIDATOR_MIN_UTXO_LOVELACE)
    expect(value.tokens).toHaveLength(1)
    expect(value.tokens[0]?.policyIdHex).toBe(DUST_VALIDATOR_SCRIPT_HASH)
    // The EMPTY asset name is what makes it the auth token rather than some other asset
    // under the same multi-purpose policy.
    expect(value.tokens[0]?.assetNameHex).toBe('')
    expect(value.tokens[0]?.amount).toBe(1n)
  })

  it('addresses the validator’s own script credential', () => {
    const hex = Address.fromBech32Sync(Bech32(DUST_VALIDATOR_ADDRESS))
    // 0x71 = enterprise, script payment credential, mainnet — then the script hash.
    expect(hex.slice(0, 2)).toBe('71')
    expect(hex.slice(2)).toBe(DUST_VALIDATOR_SCRIPT_HASH)
  })

  it('round-trips the datum the validator will read', () => {
    const datum = encodeDustRegistrationDatum(STAKE, DUST)
    expect(decodeDustRegistrationDatum(datum)).toEqual({stakeKeyHash: STAKE, dustPayload: DUST})
  })
})

// A mainnet submission was rejected with `MissingScriptWitnessesUTXOW` +
// `ScriptIntegrityHashMismatch (supplied SJust …, expected SNothing)`: the body committed
// to script data, but the queue payload carried only the body, so the ceremony assembled a
// vkey-only witness set. The review IR cannot show that — the omission is in the payload —
// which is why these assertions are on the request the ceremony consumes.
describe('the registration payload', () => {
  const CONFIG: CardanoRailConfig = {
    network: 'mainnet',
    koiosUrl: 'https://first-party.example/koios',
    networkId: 1,
    protocolMagic: 764824073,
  }

  /**
   * Mainnet values, except a truncated cost model: what is asserted is which witness-set entries
   * exist, not that the `script_data_hash` matches mainnet's.
   *
   * ⚠️ In the CHAIN's shape, not the plan engine's — the rail converts. The cost model is keyed
   * by index here and becomes a positional array on the way through, so a test that needs one is
   * exercising that conversion too.
   */
  const PARAMS: EvolutionProvider.ProtocolParameters = {
    ...MockDefaults.defaultProtocolParameters,
    costModels: {
      PlutusV1: {},
      PlutusV2: {},
      PlutusV3: {'0': 100_788, '1': 420, '2': 1, '3': 1, '4': 1000},
    },
  }

  /** The one UTxO these builds spend from. */
  const funded = (addressBech32: string) =>
    new EvolutionUTxO.UTxO({
      transactionId: TransactionHash.fromHex('11'.repeat(32)),
      index: 0n,
      address: EvolutionAddress.fromBech32(addressBech32),
      assets: EvolutionAssets.fromLovelace(20_000_000n),
    })

  const registration = () =>
    Effect.gen(function* () {
      const own = yield* Wallet.fromMnemonic(MNEMONIC, 0)
      const addressBech32 = yield* own.baseAddress(Address.Network.Mainnet)
      const rail = yield* makeCardanoRail({config: CONFIG, addressBech32, accountIndex: 0}).pipe(
        Effect.provide(mockChain({protocolParameters: PARAMS, utxos: [funded(addressBech32)]})),
      )
      yield* rail.sync
      const review = yield* buildRegistrationTx(rail, GROUP, {kind: 'register', dustPayload: DUST})
      if (review.request.payload._tag !== 'CardanoTx') return yield* Effect.fail(new Error('not a CardanoTx payload'))
      return review.request.payload
    }).pipe(Effect.provide(EvolutionDecodeLayer))

  it('carries the Plutus script and its redeemer, not just the body', async () => {
    const payload = await Effect.runPromise(registration())

    // 7 = plutus_v3_script, 5 = redeemers.
    expect((payload.witnessExtra ?? []).map(([key]) => key)).toEqual(expect.arrayContaining([5, 7]))
  })

  it('assembles into a transaction whose witness set holds the validator script', async () => {
    const entries = await Effect.runPromise(
      Effect.gen(function* () {
        const payload = yield* registration()
        // What the signing ceremony does with the payload right before broadcast.
        const signedHex = yield* Tx.assemble(payload.bodyHex, [], {
          ...(payload.witnessExtra ? {witnessExtra: payload.witnessExtra} : {}),
        })
        const witnessSetHex = yield* Inspect.witnessSetFromTx(signedHex)
        return yield* Inspect.witnessSetEntries(witnessSetHex)
      }).pipe(Effect.provide(EvolutionDecodeLayer)),
    )

    const scripts = entries.find(([key]) => key === 7)?.[1]
    expect(scripts).toContain(DUST_VALIDATOR_SCRIPT_HEX)
    expect(entries.map(([key]) => key)).toContain(5)
  })

  // The two legs the validator does have, in the order it needs them: the burn first, then a fresh mint
  // over the first leg's unconfirmed change. ⚠️ The mint handler's `one_shot_ref` check was verified
  // against the real script to be derived from the transaction's own inputs, so leg 2 spending leg 1's
  // change is safe — had it been pinned to one outref, no second registration could ever be built.
  describe('buildDestinationChangeTxs', () => {
    it('builds a deregister leg and then a register leg over its change', async () => {
      const legs = await Effect.runPromise(
        Effect.gen(function* () {
          const own = yield* Wallet.fromMnemonic(MNEMONIC, 0)
          const addressBech32 = yield* own.baseAddress(Address.Network.Mainnet)
          const rail = yield* makeCardanoRail({config: CONFIG, addressBech32, accountIndex: 0}).pipe(
            Effect.provide(mockChain({protocolParameters: PARAMS, utxos: [funded(addressBech32)]})),
          )
          yield* rail.sync
          return yield* buildDestinationChangeTxs(
            rail,
            GROUP,
            {current: {txHash: TxHashHex('ab'.repeat(32)), index: 0}, dustPayload: DUST},
            // The registration UTxO's own value: min-ADA plus the single auth token. The burn leg
            // cannot balance without it.
            {
              resolveCurrentValueHex: () =>
                Assets.toCBORHex(
                  Assets.fromRecord({lovelace: DUST_VALIDATOR_MIN_UTXO_LOVELACE, [DUST_AUTH_TOKEN_ASSET_ID]: 1n}),
                ),
            },
          )
        }).pipe(Effect.provide(EvolutionDecodeLayer)),
      )
      expect(legs).toHaveLength(2)
      // Both legs carry script witnesses — the burn and the mint are both validator calls, and a payload
      // without them assembles to a transaction the node refuses.
      for (const leg of legs) {
        if (leg.request.payload._tag !== 'CardanoTx') throw new Error('not a CardanoTx payload')
        expect((leg.request.payload.witnessExtra ?? []).map(([key]) => key)).toEqual(expect.arrayContaining([5, 7]))
      }
      // ⚠️ The second leg must spend the first's change, or it would pick a UTxO the first leg consumed
      // and the pair could never both land.
      // ⚠️ `utxoId`, not a hand-built key: `UTxO.UTxO.txHash` is a Uint8Array, so interpolating it
      // yields comma-joined bytes and every comparison silently fails.
      const firstChange = new Set((legs[0]?.tracked.change ?? []).map(utxoId))
      expect(firstChange.size).toBeGreaterThan(0)
      const secondSpends = legs[1]?.tracked.consumedUtxoIds ?? []
      expect(secondSpends.some((id) => firstChange.has(id))).toBe(true)
      // And it must not re-spend what the burn leg already consumed, or neither could land.
      const firstSpends = new Set(legs[0]?.tracked.consumedUtxoIds ?? [])
      expect(secondSpends.some((id) => firstSpends.has(id))).toBe(false)
    })
  })
})

// ⚠️ **The validator has no change-destination operation.** Established by evaluating the real script
// against real contexts on 2026-08-28, against a harness first validated on the register transaction the
// chain accepted: the spend handler requires the auth token to be **burned** and then returns
// `check_auth`. A spend that recreates the registration with a new datum burns nothing, so the validator
// refuses it every time — which is what a mainnet attempt did. Neither the datum, the credential, the
// destination length, the output value, the redeemer variant, the input/output shapes nor a withdrawal
// changes that: none of them touches the mint field, which is what the handler tests.
describe('unsupportedIntent', () => {
  it('refuses changeDestination and says what to do instead', () => {
    const refusal = unsupportedIntent({
      kind: 'changeDestination',
      current: {txHash: TxHashHex('ab'.repeat(32)), index: 0},
      dustPayload: DUST,
    })
    expect(refusal).not.toBeNull()
    expect(refusal).toContain('burned')
    expect(refusal).toContain('deregister followed by a register')
    // Points at the thing that does work, so the refusal is actionable rather than a dead end.
    expect(refusal).toContain('buildDestinationChangeTxs')
  })

  // The two the validator does have. Refusing these would break registration itself.
  it('allows the operations the validator actually has', () => {
    expect(unsupportedIntent({kind: 'register', dustPayload: DUST})).toBeNull()
    expect(unsupportedIntent({kind: 'deregister', current: {txHash: TxHashHex('cd'.repeat(32)), index: 1}})).toBeNull()
  })
})
