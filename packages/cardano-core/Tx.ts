// Transaction signing/assembly helpers (A4): partial signing + witness combining
// for multiparty/multisig, and tx-id + output→utxo helpers for chaining.

import {
  Bytes,
  Transaction,
  TransactionBody,
  TransactionHash,
  TransactionInput,
  TransactionWitnessSet,
} from '@evolution-sdk/evolution'
import {TxHashHex, type XprvHex} from '@evolution-sdk/review/Brands'
import * as Keys from './Keys.js'
import {op} from './Op.js'

/**
 * The transaction-body hash — the transaction id — over the bytes GIVEN.
 *
 * ⚠️ `toHashFromBytes`, not decoding first. A decoded body replays its arrival bytes now, so the
 * two agree; hashing what the caller holds cannot disagree with it by construction, which is the
 * property a body shared between co-signers needs.
 *
 * Synchronous and throwing, like the rest of this tier's leaves: most callers already sit inside
 * an `Effect.try` of their own, or in plain code with nowhere to put a typed failure.
 */
export const bodyHash = (bodyHex: string): TxHashHex =>
  TxHashHex(TransactionHash.toHex(TransactionBody.toHashFromBytes(Bytes.fromHex(bodyHex))))

/** The transaction id of a whole signed transaction, by slicing its body out first. */
export const bodyHashOfSigned = (signedTxHex: string): TxHashHex =>
  TxHashHex(
    TransactionHash.toHex(TransactionBody.toHashFromBytes(Transaction.extractBodyBytes(Bytes.fromHex(signedTxHex)))),
  )

/** A transaction input as its own CBOR: `[tx_id, index]`. */
export const inputHex = (txHashHex: string, index: bigint): string =>
  TransactionInput.toCBORHex(
    new TransactionInput.TransactionInput({transactionId: TransactionHash.fromHex(txHashHex), index}),
  )

export interface VkeyWitnessHex {
  readonly vkeyHex: string
  readonly sigHex: string
}

/** One party signs a shared body → its vkey witness (multiparty/multisig). */
export const partialSign = (bodyHex: string, xprvHex: XprvHex) =>
  op('partialSign', (): VkeyWitnessHex => {
    // `toHashFromBytes`, over the bytes the other parties were shown. A decoded body replays its
    // arrival bytes now, so the two agree — but hashing what we hold cannot disagree by
    // construction, which is the property a shared body needs.
    const hash = TransactionHash.toHex(TransactionBody.toHashFromBytes(Bytes.fromHex(bodyHex)))
    return {vkeyHex: Keys.publicKeySync(xprvHex), sigHex: Keys.signSync(xprvHex, hash)}
  })

/**
 * Combine collected vkey witnesses (and any native scripts / plutus witness
 * extras) into a signed tx. This is the multiparty "finalize" step.
 */
export const assemble = (
  bodyHex: string,
  witnesses: ReadonlyArray<VkeyWitnessHex>,
  opts: {
    readonly nativeScripts?: ReadonlyArray<string>
    readonly witnessExtra?: ReadonlyArray<readonly [number, string]>
    readonly auxHex?: string
  } = {},
) =>
  op('assemble', () =>
    Transaction.toCBORHex(
      Transaction.fromEncoded({
        body: Bytes.fromHex(bodyHex),
        witnessSet: TransactionWitnessSet.fromEncoded({
          vkeyWitnesses: witnesses.map((w) => ({
            vkey: Bytes.fromHex(w.vkeyHex),
            signature: Bytes.fromHex(w.sigHex),
          })),
          nativeScripts: (opts.nativeScripts ?? []).map((h) => Bytes.fromHex(h)),
          fields: (opts.witnessExtra ?? []).map(([key, hex]) => [key, Bytes.fromHex(hex)] as const),
        }),
        ...(opts.auxHex === undefined || opts.auxHex === '' ? {} : {auxiliaryData: Bytes.fromHex(opts.auxHex)}),
      }),
    ),
  )
