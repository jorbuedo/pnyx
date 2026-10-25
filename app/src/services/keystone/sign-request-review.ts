/**
 * From a completed scan to a review decision.
 *
 * One place composes classification and the UTxO cross-check, so no screen can reach the review
 * surface having done only half of it. The output is deliberately a closed union: a screen renders
 * exactly one of these and cannot invent a fourth state where an unverified request looks signable.
 *
 * @module
 */

import type {UTxO} from '@evolution-sdk/evolution'
import * as Cbor from '@evolution-sdk/evolution/CBORBuilder'
import * as Inspect from '@evolution-sdk/review/Inspect'
import {hex} from '@pnyx/crypto'
import {type CardanoSignRequest, classifyScannedUr, type Ur} from '@pnyx/ur'
import {Effect, Either} from 'effect'
import {reasonOfThrown} from '../../utils/effect-failure'
import {type CheckedInput, checkRequestUtxos, indexUtxosByOutpoint} from './verify-request-utxos'

export type SignRequestDecision =
  /** Safe to put in front of the user. */
  | {
      readonly kind: 'reviewable'
      readonly request: CardanoSignRequest
      /**
       * The transaction body, sliced out of `request.signData` — the bytes the review renders and
       * the witness is made over. See {@link transactionBodyOf}.
       */
      readonly bodyHex: string
      readonly inputs: readonly CheckedInput[]
      /** How many inputs we could not confirm. Non-zero must be visible on the screen. */
      readonly unknownCount: number
      /**
       * The request's `origin`, if it sent one. **Attacker-authored** — render it labelled as
       * unverified or not at all, never as provenance.
       */
      readonly unverifiedOrigin?: string
    }
  /** Do not offer to sign. `reason` is for the user; `detail` is for the log. */
  | {readonly kind: 'refused'; readonly reason: RefusalReason; readonly detail: string}

export type RefusalReason =
  /** Tag 2212: a bare transaction hash, with nothing to review. */
  | 'tx-hash-only'
  /** A UR we do not implement — a Bitcoin PSBT, say. */
  | 'unsupported-type'
  /** The payload did not parse. */
  | 'malformed'
  /** A claimed UTxO contradicts our own synced record. */
  | 'contradicts-our-state'
  /** The request is for a different Cardano network than this wallet is on. */
  | 'wrong-network'

/**
 * The network an address declares, from its bech32 human-readable part (CIP-19), or `undefined`
 * when it declares none we can read — a Byron address, or something we have no opinion about.
 *
 * A prefix test rather than a decode: this runs in a pure decision before any codec is reachable,
 * and the HRP is exactly the field that carries the network.
 */
export const networkOfAddress = (bech32: string): number | undefined => {
  if (bech32.startsWith('addr_test1') || bech32.startsWith('stake_test1')) return 0
  if (bech32.startsWith('addr1') || bech32.startsWith('stake1')) return 1
  return undefined
}

/**
 * Whether a network a transaction *declares* disagrees with the one we are on.
 *
 * `declared` is absent for most transactions — `network_id` is an optional body field — which is
 * why this is a backstop and not the primary gate. The primary gate is the claimed UTxO
 * addresses, which are always present; see {@link decideSignRequest}.
 */
export const networkMismatch = (declared: number | undefined, ours: number): boolean =>
  declared !== undefined && declared !== ours

/**
 * The transaction body carried by a request's `signData`, as hex, or why it carries none.
 *
 * `signData` is **the whole unsigned transaction** — `[body, witness_set, is_valid,
 * auxiliary_data]` — which is what Keystone's published field description ("the serialized
 * unsigned transaction data") means and what Eternl sends. Everything downstream works on the
 * body alone: the review reads it, and a Cardano witness is over `blake2b256(body)`. So the body
 * is sliced out **verbatim** — never re-encoded, or the hash would drift from the one the
 * coordinator is waiting for and the signature would be over bytes nobody asked about.
 *
 * A bare body is accepted as well. The two shapes cannot be confused — a transaction is a CBOR
 * array, a body is a CBOR map — so there is nothing to guess at, and a request we could review in
 * full should not fail over which of the two a counterparty chose to send. Either way the body is
 * measured, not assumed: it is exactly the span of its own CBOR item, so a truncated one is
 * refused here rather than failing later with the request already presented as signable.
 */
export const transactionBodyOf = (signData: Uint8Array): Either.Either<string, string> => {
  const major = signData[0] === undefined ? undefined : signData[0] >> 5
  if (major !== 5) {
    return Either.mapLeft(
      Effect.runSync(Effect.either(Inspect.txBodyFromTx(hex.encode(signData)))),
      (error) => error.message,
    )
  }
  try {
    return Either.right(hex.encode(signData.subarray(0, Cbor.itemLen(signData, 0))))
  } catch (error) {
    return Either.left(reasonOfThrown(error))
  }
}

/**
 * Decide what to do with a scanned UR.
 *
 * `syncedUtxos` should be every UTxO the wallet knows across the accounts that could be asked to
 * sign. Passing too few is safe but degrades inputs to `unknown`; passing another wallet's would
 * be wrong, since a coincidental outpoint match would then read as verified.
 *
 * `ourNetworkId` is Cardano's (0 testnet / 1 mainnet), and is required rather than optional
 * because a request carries **no network of its own**. Nothing in `cardano-sign-request` names one
 * — so without this the wallet would sign whatever it was handed, and a Cardano witness is over
 * the body hash, meaning a signature produced by a testnet-configured wallet is perfectly valid on
 * mainnet. The claimed UTxO addresses are the network the request implies, and they are checked
 * against ours here.
 */
export const decideSignRequest = (
  ur: Ur,
  syncedUtxos: readonly UTxO.UTxO[],
  ourNetworkId: number,
): SignRequestDecision => {
  const classified = classifyScannedUr(ur)

  switch (classified.kind) {
    case 'refused-tx-hash-only':
      return {
        kind: 'refused',
        reason: 'tx-hash-only',
        detail: 'cardano-sign-tx-hash-request carries no reviewable body',
      }
    case 'unsupported':
      return {kind: 'refused', reason: 'unsupported-type', detail: classified.urType}
    // Reachable only if a caller routed a key-derivation call here. It is answered with an
    // account export, not a signature, and this function has no way to do that — so it refuses
    // rather than falling through to a review of something that is not a transaction.
    case 'qr-hardware-call':
      return {kind: 'refused', reason: 'unsupported-type', detail: 'qr-hardware-call is not a signing request'}
    case 'malformed':
      return {kind: 'refused', reason: 'malformed', detail: classified.detail}
    case 'cardano-sign-request': {
      const body = transactionBodyOf(classified.request.signData)
      if (Either.isLeft(body)) {
        return {kind: 'refused', reason: 'malformed', detail: `signData carries no transaction body: ${body.left}`}
      }

      // Before anything is rendered: a request describing another network's coins is not one this
      // wallet has any business signing, and the mistake is not the user's to overrule.
      const foreign = classified.request.utxos.find((utxo) => {
        const declared = networkOfAddress(utxo.address)
        return declared !== undefined && declared !== ourNetworkId
      })
      if (foreign !== undefined) {
        return {
          kind: 'refused',
          reason: 'wrong-network',
          detail: `input ${foreign.address.slice(0, 12)}… is on network ${networkOfAddress(foreign.address)}, this wallet is on ${ourNetworkId}`,
        }
      }

      const checked = checkRequestUtxos(classified.request.utxos, indexUtxosByOutpoint(syncedUtxos))
      if (checked.kind === 'refused') {
        return {kind: 'refused', reason: 'contradicts-our-state', detail: checked.reason}
      }
      const {origin} = classified.request
      return {
        kind: 'reviewable',
        request: classified.request,
        bodyHex: body.right,
        inputs: checked.inputs,
        unknownCount: checked.unknownCount,
        ...(origin === undefined ? {} : {unverifiedOrigin: origin}),
      }
    }
  }
}
