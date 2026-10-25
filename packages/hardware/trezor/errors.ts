/**
 * Trezor error handling utilities.
 *
 * @module
 */

import {
  type DeviceLockedError,
  DeviceNotConnectedError,
  DeviceTimeoutError,
  HardwareError,
  TransportError,
  UserRejectedError,
  VersionTooOldError,
} from '../types'
import {matchesPattern} from '../utils'

/**
 * Trezor failure codes returned by the firmware.
 * These are the authoritative indicator of what happened on the device.
 */
const USER_REJECTION_CODES = new Set(['Failure_ActionCancelled', 'Failure_PinCancelled'])

/**
 * Error message patterns for detection.
 *
 * IMPORTANT: User-rejection patterns must be specific enough to avoid false positives.
 * Generic words like "cancelled" or "denied" match non-rejection errors
 * (e.g., "permission denied" for USB, "session cancelled" for protocol errors).
 * Prefer failure codes via {@link USER_REJECTION_CODES} over message pattern matching.
 */
const errorPatterns = {
  userRejection: ['cancelled by user', 'rejected by user', 'action cancelled'],
  passphraseMismatch: ['no witness for', 'passphrase'],
  featureNotSupported: ['feature', 'not supported'],
  iframeTimeout: ['iframe timeout', 'popup timeout'],
  permissionDenied: ['permissions not granted', 'permission denied'],
  transferError: ['failed to execute', 'transferin', 'transferout'],
  connectionError: ['device disconnected', 'session not found', 'device not found'],
  conwayNotSupported: ['conway', 'not supported'],
  auxiliaryNotSupported: ['auxiliarydata', 'not supported'],
} as const

const TREZOR_REQUIRED_FIRMWARE_REGEX = /requires Trezor firmware ([0-9.]+)\+ \(current: ([^)]+)\)/i

/**
 * Checks if the error is a user rejection.
 */
export const isUserRejectionError = (error: unknown): boolean => {
  return matchesPattern(error, errorPatterns.userRejection)
}

/**
 * Checks if the error is a passphrase mismatch.
 */
export const isPassphraseMismatchError = (error: unknown): boolean => {
  return matchesPattern(error, errorPatterns.passphraseMismatch)
}

/**
 * Checks if the error indicates a feature is not supported.
 */
export const isFeatureNotSupportedError = (error: unknown): boolean => {
  return matchesPattern(error, errorPatterns.featureNotSupported)
}

/**
 * Checks if the error is an iframe/popup timeout.
 */
export const isIframeTimeoutError = (error: unknown): boolean => {
  return matchesPattern(error, errorPatterns.iframeTimeout)
}

/**
 * Checks if the error is a permission issue.
 */
export const isPermissionDeniedError = (error: unknown): boolean => {
  return matchesPattern(error, errorPatterns.permissionDenied)
}

/**
 * Checks if the error is a USB transfer error.
 */
export const isTransferError = (error: unknown): boolean => {
  return matchesPattern(error, errorPatterns.transferError)
}

/**
 * Checks if the error is a connection error.
 */
export const isConnectionError = (error: unknown): boolean => {
  return matchesPattern(error, errorPatterns.connectionError)
}

/**
 * Checks if Conway features are not supported.
 */
export const isConwayNotSupportedError = (error: unknown): boolean => {
  return matchesPattern(error, errorPatterns.conwayNotSupported)
}

/**
 * Checks if auxiliary data features are not supported.
 */
export const isAuxiliaryNotSupportedError = (error: unknown): boolean => {
  return matchesPattern(error, errorPatterns.auxiliaryNotSupported)
}

/**
 * Maps a Trezor error to a typed error.
 *
 * @param error - The original error
 * @param operation - The operation that was being performed
 * @param failureCode - The Trezor firmware failure code (e.g. 'Failure_ActionCancelled'),
 *   available when the error originates from a device Failure response.
 * @returns A typed error
 */
export const mapTrezorError = (
  error: unknown,
  operation = 'unknown',
  failureCode?: string,
):
  | HardwareError
  | DeviceNotConnectedError
  | UserRejectedError
  | DeviceTimeoutError
  | DeviceLockedError
  | TransportError
  | VersionTooOldError => {
  const message = error instanceof Error ? error.message : String(error)

  // Check structured failure code first — this is the most reliable signal
  // and avoids false positives from message pattern matching.
  if (failureCode && USER_REJECTION_CODES.has(failureCode)) {
    return new UserRejectedError({operation})
  }

  // Trezor Connect's user-cancel path sometimes rejects the SDK Promise
  // (rather than resolving with `{success: false}`) with a bare
  // `Error('Cancelled')` and no `code` field anywhere — the catch arm of
  // `Effect.tryPromise` reaches here without a `failureCode`. Treat the
  // exact `'Cancelled'` message as a user rejection so we don't
  // surface a generic "device needs attention" error in that case.
  if (message === 'Cancelled') {
    return new UserRejectedError({operation})
  }

  // Check for passphrase mismatch (special case of user error)
  if (isPassphraseMismatchError(error)) {
    return new HardwareError({
      message: 'Passphrase mismatch. The device may be using a different passphrase.',
      cause: error,
    })
  }

  // Check for feature not supported (version too old)
  if (isConwayNotSupportedError(error)) {
    return new VersionTooOldError({
      current: 'unknown',
      required: '2.8.1',
      component: 'firmware',
    })
  }

  if (isAuxiliaryNotSupportedError(error)) {
    return new VersionTooOldError({
      current: 'unknown',
      required: '2.4.0',
      component: 'firmware',
    })
  }

  const requiredFirmwareMatch = TREZOR_REQUIRED_FIRMWARE_REGEX.exec(message)
  if (requiredFirmwareMatch) {
    const required = requiredFirmwareMatch[1] ?? 'unknown'
    const current = requiredFirmwareMatch[2] ?? 'unknown'
    return new VersionTooOldError({
      current,
      required,
      component: 'firmware',
    })
  }

  // Check for timeout
  if (isIframeTimeoutError(error)) {
    return new DeviceTimeoutError({
      operation,
      timeoutMs: 120000,
    })
  }

  // Check for permission issues — BEFORE user rejection to avoid
  // "permission denied" matching the broad rejection patterns
  if (isPermissionDeniedError(error)) {
    return new TransportError({
      transportType: 'webusb',
      message: 'WebUSB permission denied',
      cause: error,
    })
  }

  // Check for transfer errors
  if (isTransferError(error)) {
    return new TransportError({
      transportType: 'usb',
      message: 'USB transfer failed',
      cause: error,
    })
  }

  // Check for connection errors
  if (isConnectionError(error)) {
    return new DeviceNotConnectedError({
      deviceType: 'trezor',
      message: error instanceof Error ? error.message : 'Device disconnected',
    })
  }

  // Fallback user rejection check via message patterns — only reached when
  // no structured failure code was provided (e.g. errors from non-protocol sources)
  if (isUserRejectionError(error)) {
    return new UserRejectedError({operation})
  }

  // Default to generic hardware error
  return new HardwareError({
    message,
    cause: error,
  })
}

/**
 * Extracts error message from a Trezor response.
 */
export const extractTrezorError = (response: {success: false; payload: {error: string; code?: string}}): string => {
  return response.payload.error
}

/**
 * Extract the structured firmware failure code (e.g. `Failure_ActionCancelled`)
 * from a Trezor `{success: false}` response. Newer Trezor Connect / THP paths
 * surface the code on `payload.code`; legacy paths put the same `Failure_*`
 * token on `payload.error`. The web SDK on user-cancel paths (popup-mode
 * `ethereumSignMessage`, `signTransaction`, etc.) frequently returns
 * `{error: 'Cancelled'}` with NO `code` field — a localised, non-`Failure_*`
 * string the message-pattern fallback in `mapTrezorError` can't recognise.
 * We map that exact bare message to `Failure_ActionCancelled` so the
 * structured user-rejection check fires.
 *
 * Returns `undefined` when nothing recognisable is present so
 * `mapTrezorError`'s message-pattern fallback still gets a chance for any
 * other message shape.
 */
export const extractTrezorFailureCode = (response: {
  success: false
  payload: {error: string; code?: string}
}): string | undefined => {
  if (response.payload.code) return response.payload.code
  if (response.payload.error?.startsWith('Failure_')) return response.payload.error
  // Trezor Connect's user-cancel response carries the bare string
  // `'Cancelled'` instead of a structured code. Treat it as the cancel
  // code so the upstream `USER_REJECTION_CODES` check sees a match.
  if (response.payload.error === 'Cancelled') return 'Failure_ActionCancelled'
  return undefined
}
