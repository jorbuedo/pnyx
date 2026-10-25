/**
 * Passkey-PRF recovery rail (docs/mobile-shell-plan.md phase 2 item 8).
 *
 * The enclave-generated seed stays primary; this is A recovery path, not the
 * only one (encrypted-backup export and manual mnemonic restore remain).
 *
 * Enrollment: create a passkey for the Pnyx rp id, evaluate the WebAuthn PRF
 * extension with a fixed domain-separated salt, derive a wrapping key
 * `wk = HKDF-SHA256(prf, 'pnyx:prf-wrap:v1')`, and store the mnemonic
 * encrypted with XChaCha20-Poly1305 under `wk` next to the credential id.
 *
 * Recovery: assert the passkey (biometric prompt) with the same salt — the PRF
 * output is deterministic per (credential, salt) — re-derive `wk`, decrypt the
 * blob, and hand the mnemonic to the existing restore flow.
 *
 * Cross-device: the blob is written to the user's own synced store (see
 * `synced-recovery-store` — iCloud Keychain on iOS, Google Block Store on
 * Android), the same custody as the passkey itself, plus a local MMKV mirror
 * for offline / same-device reads. A new device restores by reading the synced
 * blob and asserting the (provider-synced) passkey to unwrap it — no Pnyx
 * backend ever holds the ciphertext. If the user's cloud sync is off the blob
 * stays device-local and same-device recovery still works.
 *
 * @module
 */

import {sha256} from '@noble/hashes/sha2.js'
import {hex, hkdfSha256, randomBytes, utf8, xchacha20poly1305Decrypt, xchacha20poly1305Encrypt} from '@pnyx/crypto'
import {createPasskey, getPasskeyPrf, isAvailable} from '@pnyx/passkey-native'
import {Effect, Either} from 'effect'
import {logger} from '../logger'
import {storage} from '../platform/storage'
import * as syncedStore from './synced-recovery-store'

/**
 * WebAuthn rp id the recovery passkeys are scoped to. Must match a domain that
 * serves the webcredentials AASA (services/content/public/.well-known on
 * pnyx.pxkq.uk). Pre-launch, so no live credentials are invalidated by the move.
 */
const PASSKEY_RP_ID = 'pnyx.pxkq.uk'
const PASSKEY_RP_NAME = 'Pnyx'

/** Fixed PRF eval salt — sha256('pnyx:prf:v1'); versioned so a future rotation is a new salt, not a break. */
const PRF_SALT = sha256(utf8.encode('pnyx:prf:v1'))
const WRAP_KEY_INFO = utf8.encode('pnyx:prf-wrap:v1')
const BLOB_AAD = utf8.encode('pnyx:passkey-recovery:v1')
const NONCE_LENGTH = 24

const STORAGE_KEY = '@pnyx/passkey_recovery_blob'

/** Locally stored recovery record — useless without the passkey's PRF output. */
export type PasskeyRecoveryBlob = {
  readonly version: 1
  /** base64url WebAuthn credential id, used to target the passkey on restore. */
  readonly credentialId: string
  readonly nonceHex: string
  readonly ciphertextHex: string
  /** Account name at enrollment time — proposed as the restored account's name. */
  readonly accountName: string
  readonly createdAt: number
  /**
   * Midnight shielded birthday per network id — the block height this seed was created at (plan item
   * 61(a)). A restored device cannot walk a chain from genesis, so without this it scans a window
   * below the tip and silently misses every coin older than that.
   *
   * ⚠️ **Deliberately outside the ciphertext**, for two reasons. It is metadata of the same kind as
   * `createdAt`, which has always been in the clear and reveals the same thing — roughly when this
   * wallet was made. And updating it must not need a passkey prompt: a funds group can be created
   * long after enrollment, and a birthday nobody can write down is a birthday nobody has.
   *
   * ⚠️ Still `version: 1`. The wrapped payload is unchanged and older builds ignore unknown fields, so
   * a blob written here restores on a build that predates this and simply scans from the tip.
   */
  readonly birthdays?: Readonly<Record<string, number>>
}

export type PasskeyRecoveryErrorCode =
  /** Restore requested but no recovery blob exists on this device (the v1 caveat). */
  | 'no-blob'
  /** Auth-tag mismatch: wrong passkey for this blob, or a corrupted record. */
  | 'decrypt-failed'

/** Failures owned by this service; passkey-prompt failures propagate as `PasskeyError`. */
export class PasskeyRecoveryError extends Error {
  readonly code: PasskeyRecoveryErrorCode

  constructor(code: PasskeyRecoveryErrorCode, message: string) {
    super(message)
    this.name = 'PasskeyRecoveryError'
    this.code = code
  }
}

/** Whether this platform can enroll/restore with a passkey. Never throws. */
export const isPasskeyRecoveryAvailable = (): boolean => isAvailable()

const decodeHex = (value: string): Uint8Array =>
  Either.getOrThrowWith(
    hex.decode(value),
    () => new PasskeyRecoveryError('decrypt-failed', 'Corrupted recovery record'),
  )

/**
 * Keep only `network -> positive integer height` pairs.
 *
 * A malformed entry is dropped rather than rejecting the whole blob: the mnemonic is what this record
 * exists for, and refusing to restore a seed over a bad birthday would trade the recoverable thing for
 * the optimisation. Dropping is logged, because a silently absent birthday is a silently shallow scan.
 */
const parseBirthdays = (value: unknown): Readonly<Record<string, number>> | undefined => {
  if (typeof value !== 'object' || value === null) return undefined
  const out: Record<string, number> = {}
  for (const [network, height] of Object.entries(value as Record<string, unknown>)) {
    if (typeof height === 'number' && Number.isSafeInteger(height) && height > 0) {
      out[network] = height
    } else {
      logger.warn('Passkey recovery: dropping a malformed birthday from the blob', {
        origin: 'passkey-recovery',
        network,
      })
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

const parseBlob = (raw: string): PasskeyRecoveryBlob | null => {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const blob = parsed as Record<string, unknown>
    if (
      blob.version !== 1 ||
      typeof blob.credentialId !== 'string' ||
      typeof blob.nonceHex !== 'string' ||
      typeof blob.ciphertextHex !== 'string' ||
      typeof blob.accountName !== 'string' ||
      typeof blob.createdAt !== 'number'
    ) {
      return null
    }
    return {...blob, birthdays: parseBirthdays(blob.birthdays)} as PasskeyRecoveryBlob
  } catch (e: unknown) {
    // ⚠️ `null` reads as "no recovery blob for this passkey", which is what a device that never
    // backed up looks like — on the rail whose whole job is getting a mnemonic back.
    logger.warn('Passkey recovery blob could not be read; treating it as absent', {
      origin: 'passkey-recovery',
      error: String(e),
    })
    return null
  }
}

/** The recovery record, or null when none (or unreadable). */
export const getRecoveryBlob = async (): Promise<PasskeyRecoveryBlob | null> => {
  // Synced store is the source of truth (covers a fresh device); the local
  // MMKV mirror is the offline / cloud-sync-disabled fallback.
  if (syncedStore.isAvailable()) {
    try {
      const synced = await syncedStore.getItem(STORAGE_KEY)
      if (synced !== null) return parseBlob(synced)
    } catch (error) {
      logger.warn('Passkey recovery: synced-store read failed, falling back to local mirror', {
        origin: 'passkey-recovery',
        error,
      })
    }
  }
  const raw = await storage.get(STORAGE_KEY)
  return raw === null ? null : parseBlob(raw)
}

/** Whether a restorable recovery record exists (synced or locally mirrored). */
export const hasRecoveryBlob = async (): Promise<boolean> => (await getRecoveryBlob()) !== null

/** Write the blob to the user's synced store (source of truth) + a local mirror. */
const persistBlob = async (blob: PasskeyRecoveryBlob): Promise<void> => {
  const json = JSON.stringify(blob)
  await storage.set(STORAGE_KEY, json)
  if (syncedStore.isAvailable()) {
    try {
      await syncedStore.setItem(STORAGE_KEY, json)
    } catch (error) {
      logger.warn('Passkey recovery: cloud sync of the recovery blob failed (same-device recovery still works)', {
        origin: 'passkey-recovery',
        error,
      })
    }
  }
}

const deriveWrappingKey = (prfOutput: Uint8Array): Promise<Uint8Array> =>
  Effect.runPromise(hkdfSha256(prfOutput, WRAP_KEY_INFO, 32))

const obtainPrfOutput = async (credentialId: string, createOutput: Uint8Array | null): Promise<Uint8Array> => {
  if (createOutput !== null) return createOutput
  // Providers may only report `prf.enabled` on create and evaluate on get() —
  // assert the fresh credential once to obtain the deterministic output.
  const asserted = await getPasskeyPrf({rpId: PASSKEY_RP_ID, prfSalt: PRF_SALT, credentialId})
  // getPasskeyPrf throws 'prf-unsupported' before returning a null output.
  return asserted.prfOutput as Uint8Array
}

/**
 * Enroll passkey recovery for the given mnemonic: create the passkey (OS
 * biometric prompt), wrap the mnemonic under the PRF-derived key, and persist
 * the blob locally, replacing any previous enrollment on this device.
 */
export const enrollPasskeyRecovery = async (options: {
  readonly mnemonic: string
  readonly accountName: string
}): Promise<PasskeyRecoveryBlob> => {
  const created = await createPasskey({
    rpId: PASSKEY_RP_ID,
    rpName: PASSKEY_RP_NAME,
    userName: options.accountName,
    prfSalt: PRF_SALT,
  })
  const prfOutput = await obtainPrfOutput(created.credentialId, created.prfOutput)
  const wrappingKey = await deriveWrappingKey(prfOutput)
  const nonce = await Effect.runPromise(randomBytes(NONCE_LENGTH))
  const ciphertext = await Effect.runPromise(
    xchacha20poly1305Encrypt(wrappingKey, nonce, utf8.encode(options.mnemonic), BLOB_AAD),
  )
  const blob: PasskeyRecoveryBlob = {
    version: 1,
    credentialId: created.credentialId,
    nonceHex: hex.encode(nonce),
    ciphertextHex: hex.encode(ciphertext),
    accountName: options.accountName,
    createdAt: Date.now(),
  }
  await persistBlob(blob)
  return blob
}

/**
 * Record where a wallet's shielded history starts, in the one place that survives losing the phone.
 *
 * No passkey prompt: {@link PasskeyRecoveryBlob.birthdays} is outside the ciphertext precisely so this
 * can run whenever a funds group is created, which is routinely long after enrollment.
 *
 * ⚠️ **Only ever moves a birthday earlier.** A later height would skip the blocks between the two —
 * silently and permanently, since nothing rescans a range the cursor has passed.
 *
 * A device with no enrollment is not an error: there is no blob to write into, and the local record
 * (`wallet/state-store`) is still there. It returns `false` so a caller can tell that apart from a
 * write that landed.
 */
export const recordRecoveryBirthday = async (network: string, height: number): Promise<boolean> => {
  if (!Number.isSafeInteger(height) || height < 1) {
    logger.warn('Passkey recovery: refusing to record a birthday that is not a block height', {
      origin: 'passkey-recovery',
      network,
      height,
    })
    return false
  }
  const blob = await getRecoveryBlob()
  if (blob === null) {
    logger.debug('Passkey recovery: no enrollment to record a birthday into', {
      origin: 'passkey-recovery',
      network,
    })
    return false
  }
  const existing = blob.birthdays?.[network]
  if (existing !== undefined && existing <= height) return false
  await persistBlob({...blob, birthdays: {...blob.birthdays, [network]: height}})
  logger.info('Passkey recovery: birthday recorded in the recovery blob', {
    origin: 'passkey-recovery',
    network,
    height,
  })
  return true
}

/**
 * Restore the mnemonic from the local blob: assert the enrolled passkey
 * (biometric prompt), re-derive the wrapping key from the PRF output, and
 * decrypt. Throws `PasskeyRecoveryError('no-blob')` when this device has no
 * record, and `PasskeyError` when the passkey prompt itself fails.
 */
export const restoreMnemonicWithPasskey = async (): Promise<{
  readonly mnemonic: string
  readonly accountName: string
  /**
   * Per-network shielded birthdays, to be written against the **new** group id this restore creates —
   * the old one does not travel, and nothing on chain can reconstruct these.
   */
  readonly birthdays: Readonly<Record<string, number>> | undefined
}> => {
  const blob = await getRecoveryBlob()
  if (blob === null) {
    throw new PasskeyRecoveryError('no-blob', 'No passkey recovery record on this device')
  }
  const asserted = await getPasskeyPrf({rpId: PASSKEY_RP_ID, prfSalt: PRF_SALT, credentialId: blob.credentialId})
  const wrappingKey = await deriveWrappingKey(asserted.prfOutput as Uint8Array)
  let plaintext: Uint8Array
  try {
    plaintext = await Effect.runPromise(
      xchacha20poly1305Decrypt(wrappingKey, decodeHex(blob.nonceHex), decodeHex(blob.ciphertextHex), BLOB_AAD),
    )
  } catch (e) {
    if (e instanceof PasskeyRecoveryError) throw e
    throw new PasskeyRecoveryError('decrypt-failed', 'Recovery record could not be decrypted with this passkey')
  }
  const mnemonic = Either.getOrThrowWith(
    utf8.decode(plaintext),
    () => new PasskeyRecoveryError('decrypt-failed', 'Recovery record decrypted to invalid text'),
  )
  return {mnemonic, accountName: blob.accountName, birthdays: blob.birthdays}
}

/** Delete the recovery record from the synced store + local mirror. The passkey itself stays with the user's provider. */
export const removePasskeyRecovery = async (): Promise<void> => {
  await storage.remove(STORAGE_KEY)
  if (syncedStore.isAvailable()) {
    try {
      await syncedStore.removeItem(STORAGE_KEY)
    } catch (error) {
      logger.warn('Passkey recovery: synced-store removal failed', {origin: 'passkey-recovery', error})
    }
  }
}
