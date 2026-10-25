/**
 * Binds `@pnyx/crypto`'s weak-nonce detector to Cardano transactions: the
 * predicate the review IR asks per witness, and the gate that refuses to
 * broadcast a transaction whose signatures give their own keys away.
 *
 * The signed message for a Cardano vkey witness is the transaction body hash,
 * so everything here starts by reducing bytes to that hash and then asks the
 * detector one witness at a time.
 *
 * Keep the asymmetry straight (see `@pnyx/crypto/weak-nonce`): a match is
 * proof that a key is burned, a non-match is only "no leak found here". Nothing
 * in this module may be read as a clean bill of health.
 *
 * @module
 */

import type {Provider as EvolutionProvider} from '@evolution-sdk/evolution'
import * as Inspect from '@evolution-sdk/review/Inspect'
import {Tx} from '@pnyx/cardano-core'
import {detectWeakEd25519Nonce, hex} from '@pnyx/crypto'
import {Data, Effect, Either} from 'effect'

/** The witness that gave itself away, and the public derivation that proves it. */
export type LeakedWitness = {
  readonly vkeyHex: string
  /** e.g. `H(M)` — which public-data nonce reproduced the signature's R. */
  readonly derivation: string
}

/** Broadcast refused: a witness in the transaction leaks its own signing key. */
export class LeakedSigningKeyError extends Data.TaggedError('LeakedSigningKeyError')<LeakedWitness> {
  override get message(): string {
    return `refused to broadcast: witness ${this.vkeyHex} leaks its signing key (nonce derivation ${this.derivation})`
  }
}

/**
 * Flatten a broadcast failure for the surfaces whose error shape we do not control.
 *
 * ⚠️ **The `cause` chain is the half that says what happened.** A `ProviderError`'s own message
 * is the operation that failed (`Koios submitTx failed`); the node's refusal — a malformed body,
 * a fee below the minimum, an input already spent — is in the `HttpResponseError` underneath it,
 * which carries the response text. Reading `message` alone made every rejection read identically,
 * so a submit refused for OUR bytes and one refused for the network's state were the same line in
 * the log. Measured 2026-10-21: a preprod submit returned HTTP 400 and the trail said only
 * `Koios submitTx failed`.
 *
 * It stays a named function because three callers reach for it and the day a third arm appears,
 * this is where it has to be handled.
 */
export const broadcastFailureReason = (error: EvolutionProvider.ProviderError | LeakedSigningKeyError): string => {
  const detail = causeChain('cause' in error ? error.cause : undefined)
  return detail === undefined ? error.message : `${error.message}: ${detail}`
}

/** Depth bound: a cause chain is a few links, and a cyclic one must not hang a log call. */
const MAX_CAUSE_DEPTH = 5

/** The messages under an error, outermost first, as one line. */
const causeChain = (cause: unknown): string | undefined => {
  const parts: string[] = []
  let current = cause
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current !== undefined && current !== null; depth++) {
    const message =
      typeof current === 'string'
        ? current
        : typeof current === 'object' && 'message' in current && typeof current.message === 'string'
          ? current.message
          : undefined
    if (message !== undefined && message.length > 0 && !parts.includes(message)) parts.push(message)
    current = typeof current === 'object' && 'cause' in current ? current.cause : undefined
  }
  return parts.length === 0 ? undefined : parts.join(': ')
}

const bytes = (text: string): Uint8Array | null => Either.getOrNull(hex.decode(text))

/**
 * A per-witness predicate bound to one signed message, for `reviewCardanoTx`.
 *
 * `bodyHashHex` is the transaction body hash — `Tx.bodyHash(bodyHex)` on
 * the very bytes being reviewed, never a hash supplied alongside them.
 */
export const witnessLeaksSigningKey =
  (bodyHashHex: string) =>
  (vkeyHex: string, signatureHex: string): boolean => {
    const message = bytes(bodyHashHex)
    const publicKey = bytes(vkeyHex)
    const signature = bytes(signatureHex)
    if (message === null || publicKey === null || signature === null) return false
    return detectWeakEd25519Nonce(message, publicKey, signature) !== null
  }

/**
 * What a scan of a fully signed transaction found.
 *
 * `checked: false` is deliberately distinct from "no leak": bytes we could not
 * slice were never examined, and collapsing the two would turn an unreadable
 * transaction into a reassuring one.
 */
export type LeakScan =
  | {readonly checked: true; readonly leak: LeakedWitness | null}
  | {readonly checked: false; readonly reason: string}

/** Scan every vkey witness of a fully signed transaction against its body hash. */
export const scanSignedTx = (signedTxHex: string): Effect.Effect<LeakScan> =>
  Effect.gen(function* () {
    const bodyHex = yield* Inspect.txBodyFromTx(signedTxHex)
    const witnessSetHex = yield* Inspect.witnessSetFromTx(signedTxHex)
    const witnesses = yield* Inspect.witnessSetVkeys(witnessSetHex)
    const message = bytes(Tx.bodyHash(bodyHex))
    if (message === null) return {checked: false, reason: 'body hash is not hex'} as const
    for (const witness of witnesses) {
      const publicKey = bytes(witness.vkeyHex)
      const signature = bytes(witness.sigHex)
      if (publicKey === null || signature === null) continue
      const match = detectWeakEd25519Nonce(message, publicKey, signature)
      if (match !== null) return {checked: true, leak: {vkeyHex: witness.vkeyHex, ...match}} as const
    }
    return {checked: true, leak: null} as const
  }).pipe(
    Effect.catchAll((error) =>
      Effect.succeed({checked: false, reason: error instanceof Error ? error.message : String(error)} as const),
    ),
  )

/**
 * The broadcast gate. Fails when a witness is provably weak; passes both when
 * nothing matched and when the transaction could not be parsed at all — a body
 * we cannot slice is one the node will reject on its own, and turning that into
 * a scary refusal would misattribute the failure.
 */
export const guardSignedTx = (signedTxHex: string): Effect.Effect<void, LeakedSigningKeyError> =>
  scanSignedTx(signedTxHex).pipe(
    Effect.flatMap((scan) =>
      scan.checked && scan.leak !== null ? Effect.fail(new LeakedSigningKeyError(scan.leak)) : Effect.void,
    ),
  )
