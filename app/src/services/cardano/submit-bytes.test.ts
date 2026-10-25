/**
 * The bytes `rail.submit` broadcasts are the bytes that were signed.
 *
 * ⚠️ **This is a load-bearing round trip, not a formality.** `rail.submit` takes the signed hex
 * the ceremony produced, decodes it to a `Transaction`, and Evolution's `submitTx` re-encodes it
 * to POST. If that round trip is not byte-exact the node receives a transaction whose body hash
 * differs from the one every witness signed, so every signature is invalid — and the failure
 * arrives at submit, after the user has approved it. It is also silent in a different way: the
 * transaction id the wallet records in its pending overlay would not be the id on chain.
 *
 * The shapes below are the ones the app actually submits. ⚠️ What this does NOT cover is a
 * FOREIGN envelope — a body built by another tool, which may encode its input set or its
 * optional fields differently from ours. The fork's own codec vectors are where that is pinned.
 *
 * @module
 */

import {
  Assets,
  Bytes,
  Address as EvAddress,
  Transaction as EvolutionTransaction,
  TransactionBody,
  TxOut,
} from '@evolution-sdk/evolution'
import {TxHashHex} from '@evolution-sdk/review/Brands'
import {Address, Meta, Scripts, Tx, Wallet} from '@pnyx/cardano-core'
import {Effect} from 'effect'
import {beforeAll, describe, expect, it} from 'vitest'

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

/** The round trip `rail.submit` performs, as one function. */
const reEncoded = (signedTxHex: string): string =>
  hex(EvolutionTransaction.toCBORBytes(EvolutionTransaction.fromCBORHex(signedTxHex)))

const run = <A>(eff: Effect.Effect<A, unknown, unknown>): Promise<A> => Effect.runPromise(eff as Effect.Effect<A>)

type Signed = {readonly plain: string; readonly withScript: string; readonly withMetadata: string}

let signed: Signed

beforeAll(async () => {
  signed = await run(
    Effect.gen(function* () {
      const account = yield* Wallet.fromMnemonic(MNEMONIC, 0)
      const addressHex = Address.fromBech32Sync(yield* account.baseAddress(Address.Network.Testnet))
      // ⚠️ `encodingFormat: 'babbage'`, the shape the wallet emits. Conway takes the Shelley
      // array too and Evolution defaults to it, so a fixture without this is bytes nothing signs.
      const body = TransactionBody.toCBORHex(
        TransactionBody.fromEncoded({
          inputs: [Bytes.fromHex(Tx.inputHex(TxHashHex('11'.repeat(32)), 0n))],
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
      const xprv = yield* account.paymentKey()
      const w = yield* Tx.partialSign(body, xprv)
      const witnesses = [{vkeyHex: w.vkeyHex, sigHex: w.sigHex}]
      // A native script, which is what a shared wallet's envelope carries.
      const script = yield* Scripts.all([yield* Scripts.pubkey(yield* account.paymentKeyHash())])
      const auxHex = yield* Meta.auxiliaryData(yield* Meta.metadata([674n], [yield* Meta.text('pnyx')]))
      return {
        plain: yield* Tx.assemble(body, witnesses),
        withScript: yield* Tx.assemble(body, witnesses, {nativeScripts: [script]}),
        withMetadata: yield* Tx.assemble(body, witnesses, {auxHex}),
      }
    }),
  )
})

describe('the signed bytes survive the submit round trip', () => {
  it('for a plain key-witnessed transaction', () => {
    expect(reEncoded(signed.plain)).toBe(signed.plain.toLowerCase())
  })

  it('for one carrying a native script, as a shared wallet spend does', () => {
    expect(reEncoded(signed.withScript)).toBe(signed.withScript.toLowerCase())
  })

  it('for one carrying auxiliary data, as a CIP-20 message or a CIP-25 mint does', () => {
    expect(reEncoded(signed.withMetadata)).toBe(signed.withMetadata.toLowerCase())
  })
})
