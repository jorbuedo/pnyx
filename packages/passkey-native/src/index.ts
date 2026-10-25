/**
 * JS surface for the native passkey module (`PasskeyNative`).
 *
 * Wraps platform passkey create/get (Android Credential Manager today, iOS
 * ASAuthorization later) with the WebAuthn PRF extension: a deterministic
 * 32-byte output per (credential, salt), biometric-gated, synced across the
 * user's devices by their passkey provider. The native boundary is WebAuthn
 * request/response JSON (see `webauthn.ts`); this layer builds requests, parses
 * responses, and normalizes failures into typed `PasskeyError`s so callers can
 * fail soft on unsupported platforms.
 */

import {requireOptionalNativeModule} from 'expo-modules-core'
import {buildCreateRequestJson, buildGetRequestJson, parsePasskeyResponseJson} from './webauthn.js'

export {base64UrlDecode, base64UrlEncode} from './webauthn.js'

type PasskeyNativeSpec = {
  isAvailable(): boolean
  create(requestJson: string): Promise<string>
  get(requestJson: string): Promise<string>
}

const native = requireOptionalNativeModule<PasskeyNativeSpec>('PasskeyNative')

export type PasskeyErrorCode =
  /** Platform or provider cannot do passkeys (+PRF): old OS, no Play services, iOS pending. */
  | 'unsupported'
  /** The user dismissed the OS passkey prompt. */
  | 'cancelled'
  /** No matching credential exists on this device/provider. */
  | 'no-credential'
  /** The credential exists but the provider did not evaluate the PRF extension. */
  | 'prf-unsupported'
  /** Anything else (native failure, malformed response). */
  | 'failed'

/** Typed passkey failure; `code` is stable across platforms, `message` is diagnostic. */
export class PasskeyError extends Error {
  readonly code: PasskeyErrorCode

  constructor(code: PasskeyErrorCode, message: string) {
    super(message)
    this.name = 'PasskeyError'
    this.code = code
  }
}

const mapNativeError = (e: unknown): PasskeyError => {
  if (e instanceof PasskeyError) return e
  const nativeCode = typeof (e as {code?: unknown}).code === 'string' ? ((e as {code: string}).code ?? '') : ''
  const message = e instanceof Error ? e.message : String(e)
  if (nativeCode.includes('PASSKEY_UNSUPPORTED') || nativeCode.includes('PasskeyUnsupported')) {
    return new PasskeyError('unsupported', message)
  }
  if (nativeCode.includes('PASSKEY_CANCELLED') || nativeCode.includes('PasskeyCancelled')) {
    return new PasskeyError('cancelled', message)
  }
  if (nativeCode.includes('PASSKEY_NO_CREDENTIAL') || nativeCode.includes('PasskeyNoCredential')) {
    return new PasskeyError('no-credential', message)
  }
  return new PasskeyError('failed', message)
}

const randomBytes = (length: number): Uint8Array => {
  const cryptoApi = (globalThis as {crypto?: {getRandomValues?: (array: Uint8Array) => Uint8Array}}).crypto
  if (cryptoApi?.getRandomValues === undefined) {
    throw new PasskeyError('failed', 'No CSPRNG available for the WebAuthn challenge')
  }
  return cryptoApi.getRandomValues(new Uint8Array(length))
}

/** Whether this platform can create/assert passkeys with the PRF extension. Never throws. */
export const isAvailable = (): boolean => {
  try {
    return native?.isAvailable() ?? false
  } catch {
    return false
  }
}

export type CreatePasskeyOptions = {
  readonly rpId: string
  readonly rpName: string
  /** Shown in the provider UI (account name). */
  readonly userName: string
  readonly prfSalt: Uint8Array
}

export type PasskeyPrfResult = {
  /** base64url credential id — persist it to target this credential on get(). */
  readonly credentialId: string
  /** Deterministic PRF output for (credential, salt); null on create when the provider defers evaluation to get(). */
  readonly prfOutput: Uint8Array | null
}

/**
 * Create a discoverable, biometric-gated passkey with the PRF extension.
 * PRF output may be null here — callers should follow up with {@link getPasskeyPrf}
 * using the returned credential id when they need the output immediately.
 */
export const createPasskey = async (options: CreatePasskeyOptions): Promise<PasskeyPrfResult> => {
  if (native === null) throw new PasskeyError('unsupported', 'PasskeyNative module is not installed')
  const requestJson = buildCreateRequestJson({
    rpId: options.rpId,
    rpName: options.rpName,
    userName: options.userName,
    userId: randomBytes(16),
    challenge: randomBytes(32),
    prfSalt: options.prfSalt,
  })
  try {
    return parsePasskeyResponseJson(await native.create(requestJson))
  } catch (e) {
    throw mapNativeError(e)
  }
}

export type GetPasskeyPrfOptions = {
  readonly rpId: string
  readonly prfSalt: Uint8Array
  /** base64url id from enrollment; omit to let the user pick among rpId's passkeys. */
  readonly credentialId?: string | undefined
}

/**
 * Assert an existing passkey and evaluate PRF for the salt. Unlike create,
 * a missing PRF output here is an error (`prf-unsupported`) — the provider
 * holds the credential but cannot derive the recovery key from it.
 */
export const getPasskeyPrf = async (options: GetPasskeyPrfOptions): Promise<PasskeyPrfResult> => {
  if (native === null) throw new PasskeyError('unsupported', 'PasskeyNative module is not installed')
  const requestJson = buildGetRequestJson({
    rpId: options.rpId,
    challenge: randomBytes(32),
    prfSalt: options.prfSalt,
    credentialId: options.credentialId,
  })
  let parsed: PasskeyPrfResult
  try {
    parsed = parsePasskeyResponseJson(await native.get(requestJson))
  } catch (e) {
    throw mapNativeError(e)
  }
  if (parsed.prfOutput === null) {
    throw new PasskeyError('prf-unsupported', 'The passkey provider did not return a PRF output')
  }
  return parsed
}
