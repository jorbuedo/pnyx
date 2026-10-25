/**
 * Reading a hardware account's CIP-1854 co-signer key off the connected device.
 *
 * A shared wallet's roster names co-signers by their CIP-1854 account xpub. A
 * software wallet derives that from the enclave seed; a hardware wallet has no
 * seed here, so the only way to learn it is to ask the device — which is why
 * this exists and why the answer is cached the moment it arrives.
 *
 * Called at import and when adding an account (the device is already connected
 * and its Cardano app already open, so the key costs one round-trip and no extra
 * user step), and from the reconnect flow for wallets imported before this
 * landed.
 *
 * Two verbs rather than one, because the two callers know different things. An
 * import already holds the CIP-1852 xpub it is importing, so asking the device
 * for it again would be a wasted round-trip; a reconnect holds only what was
 * *stored* and has to prove the device in front of it is the same one.
 *
 * @module
 */

import type {HardwareWalletService} from '@pnyx/hardware/service'
import {Effect} from 'effect'
import {cardanoAccountPath, cardanoSharedAccountPath} from '../account'

export type DeviceKeyFailure =
  /** Nothing is connected — the caller has to run the pair flow first. */
  | {readonly kind: 'no-device'}
  /** The device answered, but not with the key this account was imported under. */
  | {readonly kind: 'wrong-device'}
  /** The device refused or the transport failed. */
  | {readonly kind: 'device-error'; readonly message: string}

/**
 * An account-level extended public key as the rest of the app spells it:
 * 32-byte public key followed by its 32-byte chain code, hex, lower case.
 *
 * Pure and exported so the format has one definition — it is compared for
 * equality against keys that came from a seed derivation, a roster entry and a
 * device, and those three agreeing is the whole basis for "which co-signer am
 * I?".
 */
export const xpubHexOf = (publicKey: Uint8Array, chainCode: Uint8Array): string => {
  let out = ''
  for (const b of publicKey) out += b.toString(16).padStart(2, '0')
  for (const b of chainCode) out += b.toString(16).padStart(2, '0')
  return out
}

/** Whether two account xpubs name the same key, however they were spelled. */
export const sameXpubHex = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

const readXpub = (
  service: HardwareWalletService,
  path: string,
): Effect.Effect<{publicKey: Uint8Array; chainCode: Uint8Array}, DeviceKeyFailure> => {
  const device = service.getCurrentDevice()
  return device === null
    ? Effect.fail({kind: 'no-device'} as const)
    : device
        .getExtendedPublicKey(path)
        .pipe(
          Effect.mapError(
            (e): DeviceKeyFailure => ({kind: 'device-error', message: e instanceof Error ? e.message : String(e)}),
          ),
        )
}

/** Read this account's CIP-1854 co-signer xpub from the connected device. */
export const readDeviceSharedAccountXpub = (
  service: HardwareWalletService,
  deviceAccountIndex: number,
): Effect.Effect<string, DeviceKeyFailure> =>
  readXpub(service, cardanoSharedAccountPath(deviceAccountIndex)).pipe(
    Effect.map((k) => xpubHexOf(k.publicKey, k.chainCode)),
  )

/**
 * Prove the connected device is the one this account was imported from, by
 * re-deriving its CIP-1852 account xpub and comparing.
 *
 * Without it a device holding a *different* seed would answer the 1854 read
 * happily, and we would file its shared key against this wallet — a roster
 * identity that can never produce a witness the wallet needs, discovered only
 * when a co-signature silently fails to satisfy the script.
 */
export const verifyDeviceAccountXpub = (
  service: HardwareWalletService,
  deviceAccountIndex: number,
  expectedAccountXpubHex: string,
): Effect.Effect<void, DeviceKeyFailure> =>
  readXpub(service, cardanoAccountPath(deviceAccountIndex)).pipe(
    Effect.flatMap((k) =>
      sameXpubHex(xpubHexOf(k.publicKey, k.chainCode), expectedAccountXpubHex)
        ? Effect.void
        : Effect.fail({kind: 'wrong-device'} as const),
    ),
  )
