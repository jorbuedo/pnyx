/**
 * Turning a reviewable scan into a signing request, and the witness set back into a reply.
 *
 * Pure and React-free, because the two rules worth getting right are decisions rather than
 * rendering: which bytes we agree to sign, and when the confirm button is allowed to exist.
 *
 * @module
 */

import {hex} from '@pnyx/crypto'
import type {CardanoDataPayload, CardanoTxPayload, SigningRequest} from '@pnyx/signing-service'
import {encodeCardanoSignature, encodeCardanoSignCip8DataSignature} from '@pnyx/ur'
import {Either} from 'effect'

import type {Cip8Decision} from './cip8-request-review'
import type {SignRequestDecision} from './sign-request-review'

export type SigningContext = {
  readonly groupId: string
  readonly networkId: number
  readonly protocolMagic: number
  /**
   * Which account signs. Required, not defaulted.
   *
   * ⚠️ It used to be absent here and the caller coalesced the missing value to `0`, which resolves
   * signing paths against the wrong account's keys on any other account. That is not a display detail:
   * the paths decide which key signs.
   */
  readonly accountIndex: number
}

/**
 * Build the signing request for a scanned sign request.
 *
 * `bodyHex` is the decision's — the body already sliced out of the request's `signData`, which
 * carries a whole transaction. Taking it from there rather than re-deriving it here is what keeps
 * the bytes reviewed and the bytes signed the same value; see `transactionBodyOf`.
 *
 * **The request's key paths are not used to choose a key.** They say which key the counterparty
 * believes signs each input, and believing them would let a request steer us into signing with a
 * key we never meant to use. `precomputedSigningPaths` is therefore left off: the signing service
 * resolves paths from the body's own required key hashes against our key registry, the same way
 * the dApp `signTx` rail does. The paths remain useful to *display*, and nowhere else.
 *
 * `partial` is always true. An air-gapped signer returns its own witnesses and the coordinator
 * assembles; demanding full witness coverage would reject every request that also needs a
 * co-signer. The cost is that neither an empty witness set nor a short one is an error here — see
 * {@link describeWitnessOutcome} and {@link witnessCoverage}.
 */
/**
 * Narrowed so a caller can read `payload.bodyHex` without a discriminant check — which is what
 * lets the review be built from the very bytes the signing request carries, rather than from a
 * second conversion of the same field that could drift from it.
 */
export type KeystoneSigningRequest = SigningRequest & {
  readonly payload: CardanoTxPayload
  /**
   * Narrowed to required for the same reason as `payload`: this builder always sets it, so a caller
   * resolving signing paths must not have to coalesce a `number | undefined` — coalescing it to `0` is
   * exactly the bug that made an air-gapped request resolve paths against the wrong account's keys.
   */
  readonly accountIndex: number
}

export const keystoneSigningRequest = (bodyHex: string, context: SigningContext): KeystoneSigningRequest => ({
  groupId: context.groupId,
  accountIndex: context.accountIndex,
  payload: {
    _tag: 'CardanoTx',
    bodyHex,
    networkId: context.networkId,
    protocolMagic: context.protocolMagic,
    signOnly: true,
    partial: true,
  },
})

export type ConfirmGate = {
  /** Whether the confirm action may be offered at all. */
  readonly canConfirm: boolean
  /**
   * Whether the user must first acknowledge that some inputs are described by the requester and
   * not verified by us. Drives the checkbox; when false there is nothing to acknowledge.
   */
  readonly needsAcknowledgement: boolean
  /** How many inputs the acknowledgement is about. Zero whenever `needsAcknowledgement` is false. */
  readonly unverifiedCount: number
}

/**
 * Whether this decision may be signed, and what the user has to accept first.
 *
 * A refusal never becomes signable — no acknowledgement, no override. Unknown inputs are
 * different in kind: they are legitimate (a co-signer's coin, an account we have not synced), so
 * they are signable, but only once the user has been told in as many words that those numbers
 * come from the requester. Dev-lead call, 2026-08-07; the alternative considered was refusing
 * them outright.
 */
export const confirmGate = (decision: SignRequestDecision, acknowledged: boolean): ConfirmGate => {
  if (decision.kind === 'refused') return {canConfirm: false, needsAcknowledgement: false, unverifiedCount: 0}
  if (decision.unknownCount === 0) return {canConfirm: true, needsAcknowledgement: false, unverifiedCount: 0}
  return {canConfirm: acknowledged, needsAcknowledgement: true, unverifiedCount: decision.unknownCount}
}

/**
 * The reply payload: the witness set we produced, under the request id it answers.
 *
 * Echoing `requestId` is what lets the coordinator match this reply to the request it sent, so it
 * is carried through untouched — including its absence, which means the requester did not ask for
 * correlation.
 */
export const signatureReply = (witnessSetHex: string, requestId: Uint8Array | undefined): Uint8Array => {
  const witnessSet = Either.getOrThrowWith(
    hex.decode(witnessSetHex),
    () => new Error('keystone: the signing service returned a witness set that is not hex'),
  )
  return encodeCardanoSignature({witnessSet, ...(requestId === undefined ? {} : {requestId})})
}

/**
 * Build the signing request for a scanned CIP-8 message.
 *
 * `signingPath` comes from the decision, which resolved it against *our* key registry — never from
 * the request, which merely claims it.
 *
 * ⚠️ `addressHex` is the COSE protected `address` header, and the two CIP-8 modes put different
 * things in it: the full address, or the 28-byte hash of the signing key. It is not optional and
 * must never be empty — the COSE signer embeds whatever it is given into the `Sig_structure`, so an
 * empty header is not "no claim", it is a different signature that verifies against nothing. The
 * decision carries the right value for its mode precisely so this call site cannot invent one.
 */
export const cip8SigningRequest = (
  decision: Extract<Cip8Decision, {kind: 'signable'}>,
  context: SigningContext,
): SigningRequest & {readonly payload: CardanoDataPayload} => ({
  groupId: context.groupId,
  payload: {
    _tag: 'CardanoData',
    addressHex: decision.mode === 'address' ? decision.addressHex : decision.keyHashHex,
    payloadHex: decision.messageHex,
    signingPath: decision.signingPath,
    networkId: context.networkId,
    protocolMagic: context.protocolMagic,
  },
})

/**
 * Encode the CIP-8 reply Pnyx presents back as a QR.
 *
 * `signature` is the COSE_Sign1 and `key` the COSE_Key, exactly as the signing service returns
 * them — 2211 carries both, and a companion needs the key to verify without deriving anything.
 */
export const cip8SignatureReply = (
  signatureHex: string,
  publicKeyHex: string,
  requestId: Uint8Array | undefined,
): Uint8Array => {
  const signature = Either.getOrThrowWith(
    hex.decode(signatureHex),
    () => new Error('keystone: the signing service returned a COSE_Sign1 that is not hex'),
  )
  const publicKey = Either.getOrThrowWith(
    hex.decode(publicKeyHex),
    () => new Error('keystone: the signing service returned a COSE_Key that is not hex'),
  )
  return encodeCardanoSignCip8DataSignature({signature, publicKey, ...(requestId === undefined ? {} : {requestId})})
}

export type WitnessCoverage = {
  /** Distinct key hashes the body requires. */
  readonly required: number
  /** How many of those this wallet holds a key for. */
  readonly ours: number
  /** The required hashes no key of ours matches, lowercased. */
  readonly missing: readonly string[]
}

/**
 * How much of what a body requires the signing service will actually witness.
 *
 * `partial: true` buys the co-signing case and costs the ability to notice a short reply: the
 * service happily returns one witness for a body needing two, and {@link describeWitnessOutcome}
 * only catches the zero case. A reply missing a witness is not refused — a co-signer's key is
 * legitimately elsewhere — but it must never be *presented* as a finished answer, because the
 * coordinator is then holding something it cannot submit and nothing on either screen says why.
 *
 * ⚠️ **`signableKeyHashes` is what the signer will sign, not what the wallet owns.** The two differ,
 * and the difference is the whole point. `resolveCardanoSigningPaths` only requires an input's
 * payment credential for inputs it can *resolve*, and the signing adapter resolves them against the
 * wallet's synced UTxOs — so an input at an address the wallet does not sync is silently not
 * required, and its key never gets used even though the registry holds it. Comparing against owned
 * keys instead would report full coverage for exactly the case this exists to catch.
 *
 * Found the hard way: an Eternl multi-delegation address (our payment key, a stake credential we
 * filter out) held the input, so the reply carried only the withdrawal's stake witness and Eternl
 * had no way to complete it.
 */
export const witnessCoverage = (
  requiredKeyHashes: readonly string[],
  signableKeyHashes: readonly string[],
): WitnessCoverage => {
  const signable = new Set(signableKeyHashes.map((h) => h.toLowerCase()))
  const required = [...new Set(requiredKeyHashes.map((h) => h.toLowerCase()))]
  const missing = required.filter((h) => !signable.has(h))
  return {required: required.length, ours: required.length - missing.length, missing}
}

export type WitnessOutcome =
  /** We produced signatures; present them. */
  | {readonly kind: 'signed'; readonly vkeyCount: number}
  /**
   * The signing succeeded and produced nothing, which `partial` signing makes possible: none of
   * the transaction's required keys are ours. Presenting an empty QR would look like a working
   * reply and leave the coordinator waiting for a signature that will never come.
   */
  | {readonly kind: 'nothing-to-sign'}

/** Classify a witness set by whether it actually carries any of our signatures. */
export const describeWitnessOutcome = (vkeyCount: number): WitnessOutcome =>
  vkeyCount === 0 ? {kind: 'nothing-to-sign'} : {kind: 'signed', vkeyCount}
