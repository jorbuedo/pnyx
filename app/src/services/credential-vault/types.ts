/**
 * Shared types for the credential vault layer.
 *
 * The credential vault is the hardware-backed keychain storage
 * (`react-native-keychain`) that protects every wallet's seed material.
 * Enclave biometrics (with OS device-passcode fallback) is the only
 * credential scheme — there is no app-level password or PIN.
 *
 * @module
 */

import {Data} from 'effect'

/**
 * Vault failure surface.
 *
 * - `not-found` — no entry stored for this `groupId`.
 * - `auth-cancelled` — user cancelled the biometric/passcode prompt or it
 *   failed enough times that the OS gave up. Retryable (re-prompt fires a
 *   fresh biometric).
 * - `key-invalidated` — biometric succeeded but the underlying keystore
 *   key is no longer usable (Android `KeyPermanentlyInvalidatedException`,
 *   AES-GCM tag mismatch, post-OS-upgrade TEE invalidation). Non-retryable
 *   — the encrypted blob on disk cannot be decrypted by this device.
 *   Recovery requires re-import from the recovery phrase.
 * - `storage` — underlying storage layer threw something unrecognised.
 */
export class VaultError extends Data.TaggedError('VaultError')<{
  readonly code: 'not-found' | 'auth-cancelled' | 'key-invalidated' | 'storage'
  readonly message: string
  readonly cause?: unknown
}> {}
