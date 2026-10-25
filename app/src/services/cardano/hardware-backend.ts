/**
 * The @pnyx/signing-service `HardwareBackend` port, implemented over
 * @pnyx/hardware's device service. Turns the port's per-op calls into the
 * device lifecycle (`setReconnectionInfo` → `ensureReady` → the connected
 * `HardwareDevice`'s Cardano signing methods) and maps hardware errors into
 * `SigningDeviceError` (flagging user rejection).
 *
 * The signing modules stay device-SDK-free: this adapter is the only place the
 * app couples the signing service to the hardware package. Compose it into a
 * rail's signing layer in place of `HardwareBackendUnavailable`.
 *
 * @module
 */

import type {ChainId} from '@pnyx/config'
import {UserRejectedError} from '@pnyx/hardware'
import type {HardwareWalletService} from '@pnyx/hardware/service'
import {type HardwareBackend, SigningDeviceError, type SigningProgress} from '@pnyx/signing-service'
import {Effect} from 'effect'

const bytesToHex = (bytes: Uint8Array): string => {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

const isTagged = (error: unknown, tag: string): boolean =>
  typeof error === 'object' && error !== null && (error as {_tag?: unknown})._tag === tag

const toDeviceError = (error: unknown): SigningDeviceError => {
  const locked = isTagged(error, 'DeviceLockedError')
  return new SigningDeviceError({
    // ⚠️ `DeviceLockedError` carries no `message` — `Data.TaggedError` only populates one when the
    // payload has it — so the generic read produced an EMPTY reason, and an empty reason makes
    // `TxReviewScreen` skip its callout entirely. That is why a locked Ledger showed nothing but
    // "Transaction failed".
    reason: locked ? 'the device is locked' : error instanceof Error ? error.message : String(error),
    cause: error,
    ...(error instanceof UserRejectedError ? {userRejected: true} : {}),
    ...(locked ? {deviceLocked: true} : {}),
  })
}

const withDeviceError = <A>(eff: Effect.Effect<A, unknown>): Effect.Effect<A, SigningDeviceError> =>
  Effect.mapError(eff, toDeviceError)

const report = (onProgress: ((p: SigningProgress) => void) | undefined, phase: SigningProgress['phase']): void => {
  onProgress?.({phase})
}

/**
 * Build the hardware backend for a given Cardano `chainId` (mainnet / preprod /
 * preview) over an already-constructed device service. `ensureReady` seeds the
 * reconnect metadata from the resolved credential so the service targets the
 * right device + transport, opens the Cardano app, and prepares the account;
 * the per-op signing calls then go to the connected device.
 */
export const createCardanoHardwareBackend = (service: HardwareWalletService, chainId: ChainId): HardwareBackend => {
  const currentDevice = (): Effect.Effect<
    NonNullable<ReturnType<HardwareWalletService['getCurrentDevice']>>,
    SigningDeviceError
  > => {
    const device = service.getCurrentDevice()
    return device === null
      ? Effect.fail(new SigningDeviceError({reason: 'no hardware device is connected'}))
      : Effect.succeed(device)
  }

  return {
    ensureReady: (credential, accountIndex, onProgress) =>
      Effect.gen(function* () {
        report(onProgress, 'connecting')
        service.setReconnectionInfo({
          deviceType: credential.deviceType,
          ...(credential.bleDeviceId !== undefined ? {bleDeviceId: credential.bleDeviceId} : {}),
          ...(credential.transportHint !== undefined ? {transportHint: credential.transportHint} : {}),
        })
        yield* withDeviceError(service.ensureReady(chainId, accountIndex))
      }),

    getAccountExtendedPublicKey: (accountPath) =>
      Effect.gen(function* () {
        // ⚠️ The service's account cache first, and that is not an optimisation. This call exists
        // for the wrong-device guard before signing, and a Ledger asks the user to confirm every
        // account-key export — so reading the device here put a second "export public key" prompt
        // in front of every signature (2026-10-08 report). `ensureReady` has already read this
        // account from THIS connection's device, and the cache is emptied on both connect and
        // disconnect, so an entry can only describe the device currently attached: comparing
        // against it answers the same question as asking again.
        const cached = [...service.getAccountCache(chainId).values()].find((a) => a.path === accountPath)
        if (cached !== undefined) return bytesToHex(cached.publicKey) + bytesToHex(cached.chainCode)
        const device = yield* currentDevice()
        const xpub = yield* withDeviceError(device.getExtendedPublicKey(accountPath))
        return bytesToHex(xpub.publicKey) + bytesToHex(xpub.chainCode)
      }),

    signCardanoTx: (request) =>
      Effect.gen(function* () {
        const device = yield* currentDevice()
        return yield* withDeviceError(device.signCardanoTransaction(request))
      }),

    signCardanoMessage: (request) =>
      Effect.gen(function* () {
        const device = yield* currentDevice()
        return yield* withDeviceError(device.signMessage(request))
      }),
  }
}
