/**
 * Ports — the injected seams the signing service orchestrates. The service owns
 * dispatch, witness assembly, and coverage checks; everything platform-bound
 * (vault decryption, device I/O, chain submission, UTxO lookups) enters through
 * these Effect services, implemented by the app.
 *
 * @module
 */

import type {CardanoSigningRequest, HardwareSignature, MessageSigningRequest, TransactionWitness} from '@pnyx/hardware'
import {Context, Effect, Layer} from 'effect'
import type {
  HardwareCredential,
  ResolvedCredential,
  SigningBroadcastError,
  SigningCredentialError,
  SigningDeviceError,
  SigningPayloadError,
  SigningProgress,
} from './types.js'
import {SigningDeviceError as DeviceError} from './types.js'

/**
 * Resolves signing material for a wallet group. The app implements this over
 * the credential vault — for software groups the mnemonic must already be
 * decrypted (inside an auth ceremony); a locked vault fails, it never prompts.
 */
export type CredentialStore = {
  readonly resolve: (groupId: string) => Effect.Effect<ResolvedCredential, SigningCredentialError>
}

export class CredentialStoreTag extends Context.Tag('@pnyx/signing-service/CredentialStore')<
  CredentialStoreTag,
  CredentialStore
>() {}

/**
 * Hardware device I/O for signing. Implemented over `@pnyx/hardware`'s
 * `HardwareWalletService`; absent hardware support, provide
 * `HardwareBackendUnavailable`.
 */
export type HardwareBackend = {
  /** Connect + open the right app + prepare the account. */
  readonly ensureReady: (
    credential: HardwareCredential,
    accountIndex: number,
    onProgress?: (progress: SigningProgress) => void,
  ) => Effect.Effect<void, SigningDeviceError>
  /** Account-level extended public key (pubkey‖chaincode hex) from the device. */
  readonly getAccountExtendedPublicKey: (accountPath: string) => Effect.Effect<string, SigningDeviceError>
  readonly signCardanoTx: (
    request: CardanoSigningRequest,
  ) => Effect.Effect<readonly TransactionWitness[], SigningDeviceError>
  readonly signCardanoMessage: (request: MessageSigningRequest) => Effect.Effect<HardwareSignature, SigningDeviceError>
}

export class HardwareBackendTag extends Context.Tag('@pnyx/signing-service/HardwareBackend')<
  HardwareBackendTag,
  HardwareBackend
>() {}

/** Fails every device operation — for apps/tests without hardware wired. */
export const HardwareBackendUnavailable: Layer.Layer<HardwareBackendTag> = Layer.succeed(HardwareBackendTag, {
  ensureReady: () => Effect.fail(new DeviceError({reason: 'hardware backend not configured'})),
  getAccountExtendedPublicKey: () => Effect.fail(new DeviceError({reason: 'hardware backend not configured'})),
  signCardanoTx: () => Effect.fail(new DeviceError({reason: 'hardware backend not configured'})),
  signCardanoMessage: () => Effect.fail(new DeviceError({reason: 'hardware backend not configured'})),
})

/** Submits an assembled signed tx. Implemented over the chain Provider. */
export type Broadcaster = {
  readonly broadcast: (
    chain: 'cardano',
    signedTxHex: string,
    networkId: number,
  ) => Effect.Effect<string, SigningBroadcastError>
}

export class BroadcasterTag extends Context.Tag('@pnyx/signing-service/Broadcaster')<BroadcasterTag, Broadcaster>() {}

/**
 * Resolves which of the group's keys a Cardano tx body needs. Implemented over
 * the wallet's UTxO snapshot (input payment creds) + cert/withdrawal analysis.
 */
export type CardanoTxContext = {
  readonly resolveSigningPaths: (
    bodyHex: string,
    groupId: string,
    accountIndex: number,
  ) => Effect.Effect<
    {readonly signingPaths: readonly string[]; readonly requiredKeyHashes: readonly string[]},
    SigningPayloadError
  >
}

export class CardanoTxContextTag extends Context.Tag('@pnyx/signing-service/CardanoTxContext')<
  CardanoTxContextTag,
  CardanoTxContext
>() {}
