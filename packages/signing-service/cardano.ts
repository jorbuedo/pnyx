/**
 * Cardano signing arm — resolves signing paths, produces vkey witnesses
 * (software: in-process BIP32 keys; hardware: via the backend port), enforces
 * witness coverage, then either returns a CIP-30 witness set (`signOnly`) or
 * assembles + broadcasts the signed tx.
 *
 * @module
 */

import {Bytes, TransactionWitnessSet, VKey} from '@evolution-sdk/evolution'
import {AddressHex, XprvHex} from '@evolution-sdk/review/Brands'
import * as CoseVerify from '@evolution-sdk/review/Cose'
import {Address, Cose, Keys, Tx} from '@pnyx/cardano-core'
import type {CoseAddressHeader} from '@pnyx/cardano-core/Cose'
import type {CardanoSigningRequest, MessageSigningRequest} from '@pnyx/hardware'
import {Effect} from 'effect'
import type {Broadcaster, CardanoTxContext, CredentialStore, HardwareBackend} from './ports.js'
import type {
  CardanoDataPayload,
  CardanoTxPayload,
  DataSigned,
  HardwareCredential,
  ResolvedCredential,
  SigningError,
  SigningProgress,
  SigningRequest,
  SigningSuccess,
  SoftwareCredential,
} from './types.js'
import {SigningDeviceError, SigningPayloadError, SigningWitnessError} from './types.js'
import {dedupeWitnesses, missingKeyHashes, parsePath} from './witness.js'

export type ProgressFn = (progress: SigningProgress) => void

const bytesToHex = (bytes: Uint8Array): string => {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

const defaultProtocolMagic = (networkId: number): number => (networkId === 1 ? 764824073 : 1)

const accountPathOf = (accountIndex: number): string => `m/1852'/1815'/${accountIndex}'`

const asPayloadError = <A, E extends {readonly message?: string; readonly reason?: string}>(
  eff: Effect.Effect<A, E, never>,
): Effect.Effect<A, SigningPayloadError> =>
  Effect.mapError(
    eff,
    (e) =>
      new SigningPayloadError({reason: ('message' in e ? e.message : undefined) ?? e.reason ?? String(e), cause: e}),
  )

type CardanoDeps = {
  readonly credentials: CredentialStore
  readonly hardware: HardwareBackend
  readonly broadcaster: Broadcaster
  readonly txContext: CardanoTxContext
}

/** Derive one vkey witness per signing path from the root key (software). */
const softwareWitnesses = (
  credential: SoftwareCredential,
  bodyHex: string,
  signingPaths: readonly string[],
): Effect.Effect<readonly Tx.VkeyWitnessHex[], SigningPayloadError> =>
  Effect.forEach(signingPaths, (path) =>
    asPayloadError(
      Effect.gen(function* () {
        const numbers = yield* Effect.try({
          try: () => parsePath(path),
          catch: (e) => ({reason: e instanceof Error ? e.message : String(e)}),
        })
        // Two brands meet here and neither implies the other: `SecretText` is agora's
        // custody marker (never log, wipe after use), `XprvHex` the library's "signing
        // key, not an xpub". Crossing is explicit so the custody claim is not lost by
        // accident — the value keeps both meanings, only its type changes.
        const xprv = yield* Keys.derivePath(XprvHex(credential.rootXprvHex), numbers)
        return yield* Tx.partialSign(bodyHex, xprv)
      }),
    ),
  )

/** Verify the connected device derives the recorded account xpub (wrong-device guard). */
const verifyDeviceIdentity = (
  hardware: CardanoDeps['hardware'],
  credential: HardwareCredential,
  accountIndex: number,
): Effect.Effect<void, SigningDeviceError> =>
  credential.accountXpubHex === undefined
    ? Effect.void
    : Effect.gen(function* () {
        const onDevice = yield* hardware.getAccountExtendedPublicKey(accountPathOf(accountIndex))
        if (onDevice.toLowerCase() !== credential.accountXpubHex?.toLowerCase()) {
          yield* Effect.fail(
            new SigningDeviceError({reason: 'connected device does not match this wallet (account key mismatch)'}),
          )
        }
      })

/**
 * Verify every produced witness's Ed25519 signature against the reviewed tx body
 * hash under its own vkey. The coverage check below only proves a witness
 * key-hash is a required signer — not that its signature actually covers the
 * intended body. A malicious or MITM'd hardware device/transport could otherwise
 * return a well-formed witness whose signature is over different bytes, which the
 * host would assemble and broadcast unchecked (blind-signing gap). Fails closed:
 * a throw from the verifier (malformed key/signature bytes) is an invalid witness.
 */
const verifyWitnessSignatures = (
  witnesses: readonly Tx.VkeyWitnessHex[],
  bodyHex: string,
): Effect.Effect<void, SigningWitnessError | SigningPayloadError> =>
  Effect.gen(function* () {
    const bodyHashHex = yield* asPayloadError(
      Effect.try({
        try: () => Tx.bodyHash(bodyHex),
        catch: (e) => ({reason: e instanceof Error ? e.message : String(e)}),
      }),
    )
    for (const w of witnesses) {
      const valid = yield* Effect.try({
        try: () => VKey.verify(VKey.fromHex(w.vkeyHex), Bytes.fromHex(bodyHashHex), Bytes.fromHex(w.sigHex)),
        catch: (e) =>
          new SigningWitnessError({
            missingKeyHashes: [],
            reason: `witness signature verification failed: ${e instanceof Error ? e.message : String(e)}`,
          }),
      })
      if (!valid) {
        return yield* Effect.fail(
          new SigningWitnessError({
            missingKeyHashes: [],
            reason: 'a produced witness does not sign the reviewed transaction body hash',
          }),
        )
      }
    }
  })

const hardwareTxWitnesses = (
  deps: CardanoDeps,
  credential: HardwareCredential,
  payload: CardanoTxPayload,
  signingPaths: readonly string[],
  accountIndex: number,
  onProgress?: ProgressFn,
): Effect.Effect<readonly Tx.VkeyWitnessHex[], SigningError> =>
  Effect.gen(function* () {
    onProgress?.({phase: 'connecting'})
    yield* deps.hardware.ensureReady(credential, accountIndex, onProgress)
    yield* verifyDeviceIdentity(deps.hardware, credential, accountIndex)
    const bodyHashHex = yield* asPayloadError(
      Effect.try({
        try: () => Tx.bodyHash(payload.bodyHex),
        catch: (e) => ({reason: e instanceof Error ? e.message : String(e)}),
      }),
    )
    // `partial` + native scripts is the caller already saying "this is one
    // co-signer's share of a script spend" — the pair is set deliberately, in one
    // place, for exactly that case. Reading it here rather than adding a third
    // flag keeps there from being two statements about the same fact that could
    // disagree; a device put in the wrong mode fails in a way whose cause is
    // nowhere near where it surfaces.
    const isMultisig = payload.partial === true && (payload.nativeScripts?.length ?? 0) > 0
    const request: CardanoSigningRequest = {
      txBodyHashHex: bodyHashHex,
      txBodyHex: payload.bodyHex,
      signingPaths,
      networkId: payload.networkId,
      protocolMagic: payload.protocolMagic ?? defaultProtocolMagic(payload.networkId),
      ...(payload.cip36Registration ? {cip36Registration: payload.cip36Registration} : {}),
      ...(isMultisig ? {multisig: true} : {}),
    }
    onProgress?.({phase: 'waiting-for-device'})
    const witnesses = yield* deps.hardware.signCardanoTx(request)
    return witnesses.map((w) => ({vkeyHex: w.publicKeyHex, sigHex: w.signatureHex}))
  })

export const signCardanoTx = (
  deps: CardanoDeps,
  request: SigningRequest,
  payload: CardanoTxPayload,
  onProgress?: ProgressFn,
): Effect.Effect<SigningSuccess, SigningError> =>
  Effect.gen(function* () {
    const accountIndex = request.accountIndex ?? 0
    onProgress?.({phase: 'resolving-keys'})
    const credential = yield* deps.credentials.resolve(request.groupId)

    const resolved =
      payload.precomputedSigningPaths !== undefined
        ? {
            signingPaths: payload.precomputedSigningPaths,
            requiredKeyHashes: payload.precomputedRequiredKeyHashes ?? [],
          }
        : yield* deps.txContext.resolveSigningPaths(payload.bodyHex, request.groupId, accountIndex)
    if (resolved.signingPaths.length === 0) {
      yield* Effect.fail(new SigningPayloadError({reason: 'no signing paths resolved for this transaction'}))
    }

    onProgress?.({phase: 'signing'})
    const raw =
      credential.kind === 'software'
        ? yield* softwareWitnesses(credential, payload.bodyHex, resolved.signingPaths)
        : yield* hardwareTxWitnesses(deps, credential, payload, resolved.signingPaths, accountIndex, onProgress)
    const witnesses = dedupeWitnesses(raw)

    // Verify every produced witness genuinely signs the reviewed tx body hash
    // under its own key before assembly — the coverage check below only proves
    // the key-hash is a required signer, not that the signature covers the body.
    yield* verifyWitnessSignatures(witnesses, payload.bodyHex)

    if (!payload.partial) {
      const witnessHashes = yield* asPayloadError(
        Effect.try({
          try: () => witnesses.map((w) => Keys.keyHashSync(w.vkeyHex)),
          catch: (e) => ({reason: e instanceof Error ? e.message : String(e)}),
        }),
      )
      const required =
        payload.precomputedRequiredKeyHashes !== undefined
          ? payload.precomputedRequiredKeyHashes
          : resolved.requiredKeyHashes
      const missing = missingKeyHashes(witnessHashes, required)
      if (missing.length > 0) {
        yield* Effect.fail(new SigningWitnessError({missingKeyHashes: missing}))
      }
    }

    onProgress?.({phase: 'assembling'})
    if (payload.signOnly) {
      const witnessSetHex = yield* asPayloadError(
        Effect.try({
          try: () =>
            TransactionWitnessSet.toCBORHex(
              TransactionWitnessSet.fromEncoded({
                vkeyWitnesses: witnesses.map((w) => ({
                  vkey: Bytes.fromHex(w.vkeyHex),
                  signature: Bytes.fromHex(w.sigHex),
                })),
              }),
            ),
          catch: (e) => ({reason: e instanceof Error ? e.message : String(e)}),
        }),
      )
      if (!payload.assembleSignOnly) return {_tag: 'TxSignedOnly', witnessSetHex} satisfies SigningSuccess
      // Assembled but deliberately NOT broadcast: the caller hands these bytes to someone else to
      // submit. The same assembly the broadcasting path uses, so the two cannot describe different
      // transactions.
      const assembledHex = yield* asPayloadError(
        Tx.assemble(payload.bodyHex, [...witnesses, ...(payload.foreignVkeyWitnesses ?? [])], {
          ...(payload.nativeScripts ? {nativeScripts: payload.nativeScripts} : {}),
          ...(payload.witnessExtra ? {witnessExtra: payload.witnessExtra} : {}),
          ...(payload.auxHex ? {auxHex: payload.auxHex} : {}),
        }),
      )
      return {_tag: 'TxSignedOnly', witnessSetHex, signedTxHex: assembledHex} satisfies SigningSuccess
    }

    const signedTxHex = yield* asPayloadError(
      // Ours first, then any the tx already carried. `assemble` writes them
      // as one key-0 array, so a co-signed tx keeps both signatures.
      Tx.assemble(payload.bodyHex, [...witnesses, ...(payload.foreignVkeyWitnesses ?? [])], {
        ...(payload.nativeScripts ? {nativeScripts: payload.nativeScripts} : {}),
        ...(payload.witnessExtra ? {witnessExtra: payload.witnessExtra} : {}),
        ...(payload.auxHex ? {auxHex: payload.auxHex} : {}),
      }),
    )
    onProgress?.({phase: 'submitting'})
    const txHash = yield* deps.broadcaster.broadcast('cardano', signedTxHex, payload.networkId)
    return {_tag: 'TxSubmitted', txHash, signedTxHex} satisfies SigningSuccess
  })

const softwareSignData = (
  credential: SoftwareCredential,
  payload: CardanoDataPayload,
): Effect.Effect<DataSigned, SigningPayloadError> =>
  asPayloadError(
    Effect.gen(function* () {
      const numbers = yield* Effect.try({
        try: () => parsePath(payload.signingPath),
        catch: (e) => ({reason: e instanceof Error ? e.message : String(e)}),
      })
      const xprv = yield* Keys.derivePath(XprvHex(credential.rootXprvHex), numbers)
      // CIP-30 `signData` carries raw address bytes as hex — branded once, then used
      // for both the ownership check and the COSE headers, which must agree.
      const addressHex = AddressHex(payload.addressHex)
      const info = yield* Effect.try({
        try: () => Address.inspect(addressHex),
        catch: (e) => ({reason: e instanceof Error ? e.message : String(e)}),
      })
      // ⚠️ **Unreadable means refuse, not proceed.** This comparison is the only thing standing
      // between a dApp-supplied address and a signature claiming it, so "no credential to
      // compare" cannot be a pass. A Byron address reaches exactly that state — it carries
      // neither credential — and the request chooses the address.
      const target = info.paymentCredHex ?? info.stakeCredHex
      if (target === undefined) {
        return yield* Effect.fail({
          reason: `cannot read an address credential to check ownership against (kind ${info.kind})`,
        })
      }
      const keyHash = Keys.keyHashSync(Keys.publicKeySync(xprv))
      if (keyHash !== target) {
        return yield* Effect.fail({
          reason: `signing path key does not match the address credential (${keyHash} ≠ ${target})`,
        })
      }
      const signature = yield* Cose.signData(xprv, addressHex, payload.payloadHex, true)
      return {_tag: 'DataSigned', signature: signature.signature, key: signature.key} satisfies DataSigned
    }),
  )

const hardwareSignData = (
  deps: CardanoDeps,
  credential: HardwareCredential,
  payload: CardanoDataPayload,
  accountIndex: number,
  onProgress?: ProgressFn,
): Effect.Effect<DataSigned, SigningError> =>
  Effect.gen(function* () {
    onProgress?.({phase: 'connecting'})
    yield* deps.hardware.ensureReady(credential, accountIndex, onProgress)
    yield* verifyDeviceIdentity(deps.hardware, credential, accountIndex)
    const request: MessageSigningRequest = {
      payloadHex: payload.payloadHex,
      signingPath: payload.signingPath,
      hashPayload: false,
      preferHexDisplay: false,
      addressFieldType: payload.hardwareAddressParams ? 'address' : 'keyHash',
      ...(payload.hardwareAddressParams ? {addressParams: payload.hardwareAddressParams} : {}),
      networkId: payload.networkId,
      protocolMagic: payload.protocolMagic ?? defaultProtocolMagic(payload.networkId),
    }
    onProgress?.({phase: 'waiting-for-device'})
    const result = yield* deps.hardware.signCardanoMessage(request)
    onProgress?.({phase: 'assembling'})
    const pubkeyHex = bytesToHex(result.publicKey)
    const signatureHex = bytesToHex(result.signature)
    // ADDRESS mode embeds the full address; KEY_HASH mode embeds blake2b-224(pubkey).
    const envelopeAddressHex: CoseAddressHeader = payload.hardwareAddressParams
      ? AddressHex(payload.addressHex)
      : yield* asPayloadError(
          Effect.try({
            try: () => Keys.keyHashSync(pubkeyHex),
            catch: (e) => ({reason: e instanceof Error ? e.message : String(e)}),
          }),
        )
    const assembled = yield* Effect.mapError(
      CoseVerify.assembleData(envelopeAddressHex, payload.payloadHex, false, pubkeyHex, signatureHex),
      (e) => new SigningPayloadError({reason: e.message, cause: e}),
    )
    const valid = yield* asPayloadError(Cose.verifyData(assembled))
    if (!valid) {
      yield* Effect.fail(
        new SigningDeviceError({reason: 'device signature failed verification against the assembled envelope'}),
      )
    }
    return {_tag: 'DataSigned', signature: assembled.signature, key: assembled.key} satisfies DataSigned
  })

export const signCardanoData = (
  deps: CardanoDeps,
  request: SigningRequest,
  payload: CardanoDataPayload,
  onProgress?: ProgressFn,
): Effect.Effect<SigningSuccess, SigningError> =>
  Effect.gen(function* () {
    const accountIndex = request.accountIndex ?? 0
    onProgress?.({phase: 'resolving-keys'})
    const credential: ResolvedCredential = yield* deps.credentials.resolve(request.groupId)
    onProgress?.({phase: 'signing'})
    return credential.kind === 'software'
      ? yield* softwareSignData(credential, payload)
      : yield* hardwareSignData(deps, credential, payload, accountIndex, onProgress)
  })

export type {CardanoDeps}
