/**
 * Classifier for native `react-native-keychain` errors.
 *
 * Replaces the legacy regex-on-message approach in `enclave-vault.ts`
 * which incorrectly mapped every TEE-level failure to `auth-cancelled`
 * because their messages contain words like "authentication" or "failed"
 * The discriminator now keys on the structured `error.code`
 * the native module emits, falling back to message-shape only to split
 * Android's overloaded `E_CRYPTO_FAILED` channel into the two cases the
 * upstream caller cares about.
 *
 * @module
 */

import {Platform} from 'react-native'

/**
 * Classified outcome for a keychain failure.
 *
 * Maps 1:1 onto {@link VaultError} code values that the enclave vault may
 * surface — `not-found` isn't produced by the keychain library itself and
 * is handled by the calling site directly.
 */
export type KeychainClassification = 'auth-cancelled' | 'key-invalidated' | 'storage'

/**
 * Android JS `error.code` values produced by `react-native-keychain` v10.
 *
 * See `KeychainModule.kt` (Errors annotation, line 92-103) and the catch
 * chain in `getGenericPassword` (line 270-279). `KeyStoreAccessException`
 * (including `KeyPermanentlyInvalidatedException` rewraps) maps to
 * `E_KEYSTORE_ACCESS_ERROR`. Every `CryptoFailedException` — biometric
 * prompt errors AND cipher-op failures after successful biometric — maps
 * to `E_CRYPTO_FAILED`. Anything else falls through to `E_UNKNOWN_ERROR`.
 */
const ANDROID_KEYSTORE_ACCESS = 'E_KEYSTORE_ACCESS_ERROR'
const ANDROID_CRYPTO_FAILED = 'E_CRYPTO_FAILED'

/**
 * Pattern used by `ResultHandlerInteractiveBiometric.onAuthenticationError`
 * to format biometric-prompt failures into the message of the
 * `CryptoFailedException` it raises. The `<int>` is one of
 * `androidx.biometric.BiometricPrompt.ERROR_*`. A `CryptoFailedException`
 * WITHOUT this prefix is a cipher-op failure thrown from
 * `decryptBytes` AFTER successful biometric (the key-invalidated path).
 */
const ANDROID_BIOMETRIC_PROMPT_RE = /^code:\s*(\d+),\s*msg:/i

/** `androidx.biometric.BiometricPrompt` ERROR_* codes treated as user-driven cancel. */
const ANDROID_USER_CANCEL_PROMPT_CODES: ReadonlySet<number> = new Set([
  3, // ERROR_TIMEOUT — user did not present biometric in time
  5, // ERROR_CANCELED — system canceled (e.g. screen off)
  10, // ERROR_USER_CANCELED — user tapped the system cancel button
  13, // ERROR_NEGATIVE_BUTTON — user tapped the prompt's "Cancel" button
])

/**
 * `androidx.biometric.BiometricPrompt` ERROR_* codes that are temporary
 * lockouts — too many failed attempts. Treated as cancel from the vault's
 * perspective: re-prompting fires a fresh biometric flow, and the OS
 * surfaces its own lockout copy in the prompt.
 */
const ANDROID_LOCKOUT_PROMPT_CODES: ReadonlySet<number> = new Set([
  7, // ERROR_LOCKOUT — temporary
  9, // ERROR_LOCKOUT_PERMANENT — requires device-credential auth
])

/**
 * iOS error codes mapped to user-cancel. `RNKeychainManager.m` puts
 * `error.code` (an integer) into the JS error code field as a string.
 *
 * - `-128` (errSecUserCanceled) — Security framework user cancel.
 * - `-2` (LAErrorUserCancel) — LocalAuthentication user cancel.
 * - `-3` (LAErrorUserFallback) — user chose to enter passcode instead.
 * - `-4` (LAErrorSystemCancel) — app went background mid-prompt.
 * - `-8` (LAErrorBiometryLockout) — temporary lockout after repeated
 *   biometric failures. Recoverable by waiting + retry or unlocking with
 *   device passcode; do NOT route through the re-import recovery sheet.
 */
const IOS_USER_CANCEL_CODES: ReadonlySet<string> = new Set(['-128', '-2', '-3', '-4', '-8'])

/**
 * iOS error codes treated as `key-invalidated`. `errSecAuthFailed`
 * (-25293) signals biometric matched but the data could not be decrypted
 * — equivalent to the Android TEE failure path. Non-recoverable without
 * seed re-import.
 */
const IOS_KEY_INVALIDATED_CODES: ReadonlySet<string> = new Set(['-25293'])

const getErrorCode = (e: unknown): string | null => {
  if (e == null || typeof e !== 'object') return null
  const code = (e as {code?: unknown}).code
  if (typeof code === 'string') return code
  // `RNKeychainManager.m` always stringifies via `codeForError` before
  // crossing the bridge, but defensively coerce numeric codes too — a
  // future RN bridge change or a non-Keychain native module reaching
  // this classifier shouldn't silently fall through to `storage` and
  // strand the key-invalidated recovery path.
  if (typeof code === 'number' && Number.isFinite(code)) return String(code)
  return null
}

const getErrorMessage = (e: unknown): string => {
  if (e instanceof Error) return e.message
  return String(e)
}

const classifyAndroid = (code: string | null, message: string): KeychainClassification => {
  if (code === ANDROID_KEYSTORE_ACCESS) return 'key-invalidated'
  if (code !== ANDROID_CRYPTO_FAILED) return 'storage'

  const match = ANDROID_BIOMETRIC_PROMPT_RE.exec(message)
  if (match === null) {
    // No "code: N, msg: ..." prefix — this is a cipher-op failure thrown
    // from `decryptBytes` AFTER successful biometric. AEADBadTagException,
    // UserNotAuthenticatedException, KeyPermanentlyInvalidatedException
    // (rewrapped). All non-recoverable without seed re-import.
    return 'key-invalidated'
  }

  const promptCode = Number(match[1])
  if (ANDROID_USER_CANCEL_PROMPT_CODES.has(promptCode)) return 'auth-cancelled'
  if (ANDROID_LOCKOUT_PROMPT_CODES.has(promptCode)) return 'auth-cancelled'
  // Unknown BiometricPrompt error code (e.g. ERROR_HW_NOT_PRESENT). Safer
  // to treat as cancel than as key-invalidated — re-prompting is harmless.
  return 'auth-cancelled'
}

const classifyIos = (code: string | null): KeychainClassification => {
  if (code === null) return 'storage'
  if (IOS_USER_CANCEL_CODES.has(code)) return 'auth-cancelled'
  if (IOS_KEY_INVALIDATED_CODES.has(code)) return 'key-invalidated'
  return 'storage'
}

/**
 * Classify a native keychain error into a vault outcome.
 *
 * @param e Raw error value caught from a `Keychain.*` promise.
 * @param platformOverride Test seam. Defaults to `Platform.OS` at runtime.
 */
export const classifyKeychainError = (
  e: unknown,
  platformOverride?: 'android' | 'ios' | 'web' | 'windows' | 'macos',
): KeychainClassification => {
  const platform = platformOverride ?? Platform.OS
  const code = getErrorCode(e)
  const message = getErrorMessage(e)

  if (platform === 'android') return classifyAndroid(code, message)
  if (platform === 'ios') return classifyIos(code)
  // Web / extension never reach the enclave path (capability probe gates
  // there). Anything that does is a programmer error — surface as storage
  // so the caller sees a typed VaultError instead of a silent fallthrough.
  return 'storage'
}
