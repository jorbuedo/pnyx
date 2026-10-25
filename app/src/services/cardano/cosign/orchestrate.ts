/**
 * Co-signing orchestration: turn a signing result into an envelope witness, add
 * this wallet's partial signature under an auth ceremony, and (once quorum is
 * met) assemble + broadcast. The partial sign reuses the signing service's
 * existing `signOnly` + `partial` + `nativeScripts` + `precomputedSigningPaths`
 * path — no bespoke signer.
 *
 * @module
 */

import * as Inspect from '@evolution-sdk/review/Inspect'
import {Keys} from '@pnyx/cardano-core'
import type {CoreError} from '@pnyx/cardano-core/Op'
import type {CardanoTxPayload, SigningRequest, SigningServiceTag} from '@pnyx/signing-service'
import {Effect, type Layer} from 'effect'
import {signTxWithCeremony} from '../ceremony-signing'
import {broadcastFailureReason} from '../leaked-key'
import type {CardanoRail} from '../rail'
import {addSignature, assembleEnvelope} from './envelope'
import type {EnvelopeWitness, TxEnvelope} from './types'

/** Decode a witness-set hex into envelope witnesses (vkey + sig + key hash). */
export const envelopeWitnessesFrom = (witnessSetHex: string): Effect.Effect<readonly EnvelopeWitness[], CoreError> =>
  Effect.gen(function* () {
    const vkeys = yield* Inspect.witnessSetVkeys(witnessSetHex).pipe(Effect.orElseSucceed(() => []))
    return yield* Effect.forEach(vkeys, (w) =>
      Effect.map(Keys.keyHash(w.vkeyHex), (keyHashHex) => ({vkeyHex: w.vkeyHex, sigHex: w.sigHex, keyHashHex})),
    )
  })

/**
 * The partial-sign request for a co-signer over an envelope's body + scripts.
 *
 * `signingPaths` is one path per payment index the transaction spends: this
 * co-signer's key is different at each, and the ledger wants a witness from every
 * one of them. Passing a single path where the transaction touches two indexes
 * produces a witness set that satisfies half the inputs.
 */
export const partialSignRequest = (
  envelope: TxEnvelope,
  groupId: string,
  signingPaths: readonly string[],
): SigningRequest => {
  const payload: CardanoTxPayload = {
    _tag: 'CardanoTx',
    bodyHex: envelope.bodyHex,
    networkId: envelope.networkId,
    ...(envelope.protocolMagic !== undefined ? {protocolMagic: envelope.protocolMagic} : {}),
    signOnly: true,
    partial: true,
    nativeScripts: envelope.nativeScriptHexes,
    ...(envelope.auxHex !== undefined ? {auxHex: envelope.auxHex} : {}),
    precomputedSigningPaths: [...signingPaths],
    precomputedRequiredKeyHashes: [],
  }
  return {groupId, payload}
}

/**
 * Add this wallet's signature to the envelope: partial-sign under a ceremony,
 * extract the vkey witness, merge it in.
 */
export const signIntoEnvelope = async (params: {
  readonly envelope: TxEnvelope
  readonly groupId: string
  /** One per payment index the transaction spends — see {@link partialSignRequest}. */
  readonly signingPaths: readonly string[]
  readonly signingLayer: Layer.Layer<SigningServiceTag>
}): Promise<TxEnvelope> => {
  const result = await signTxWithCeremony(
    params.groupId,
    partialSignRequest(params.envelope, params.groupId, params.signingPaths),
    params.signingLayer,
    {purpose: 'cosign', origin: null},
  )
  if (result._tag !== 'TxSignedOnly') throw new Error('expected a witness set from a partial sign')
  const witnesses = await Effect.runPromise(envelopeWitnessesFrom(result.witnessSetHex))
  return witnesses.reduce<TxEnvelope>((env, w) => addSignature(env, w), params.envelope)
}

/** Assemble the (quorum-met) envelope and broadcast it via the rail. */
export const submitEnvelope = (rail: CardanoRail, envelope: TxEnvelope): Effect.Effect<string, Error> =>
  Effect.gen(function* () {
    const signedTxHex = yield* assembleEnvelope(envelope)
    return yield* rail.submit(signedTxHex).pipe(Effect.mapError((e) => new Error(broadcastFailureReason(e))))
  })
