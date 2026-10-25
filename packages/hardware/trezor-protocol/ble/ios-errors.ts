/**
 * iOS CoreBluetooth error classification.
 *
 * Maps CBError.Code values to connection status types so the UI can show
 * appropriate messages. Previously only code 14 was handled.
 *
 * Reference: https://developer.apple.com/documentation/corebluetooth/cberror/code
 */

export type CBErrorClassification = 'pairing-error' | 'connection-error' | 'timeout' | 'recoverable'

const cbErrorMap: Record<number, CBErrorClassification> = {
  0: 'connection-error', // unknown
  1: 'connection-error', // invalidParameters
  2: 'connection-error', // invalidHandle
  3: 'connection-error', // notConnected
  4: 'connection-error', // outOfSpace
  5: 'recoverable', // operationCancelled
  6: 'timeout', // connectionTimeout
  7: 'connection-error', // peripheralDisconnected
  8: 'connection-error', // uuidNotAllowed
  9: 'recoverable', // alreadyAdvertising
  10: 'connection-error', // connectionFailed
  11: 'connection-error', // connectionLimitReached
  12: 'connection-error', // unknownDevice
  13: 'connection-error', // operationNotSupported
  14: 'pairing-error', // peerRemovedPairingInformation
  15: 'pairing-error', // encryptionTimedOut
  16: 'connection-error', // tooManyLEPairedDevices
}

/**
 * Classify an iOS CBError code into a connection status category.
 *
 * Returns `undefined` if the code is not an iOS-specific error (e.g. on Android).
 */
export const classifyCBError = (iosErrorCode: number | undefined): CBErrorClassification | undefined => {
  if (iosErrorCode === undefined) return undefined
  return cbErrorMap[iosErrorCode] ?? 'connection-error'
}

/**
 * Map a BLE error to a DeviceConnectionStatus type.
 *
 * Checks for iOS-specific error codes first, then falls back to reason string
 * matching, then defaults to 'connection-error'.
 */
export const classifyBleConnectionError = (err: {
  iosErrorCode?: number
  reason?: string
  message?: string
}): 'pairing-error' | 'connection-error' | 'timeout' => {
  const iosClassification = classifyCBError(err.iosErrorCode)
  if (iosClassification === 'pairing-error' || iosClassification === 'timeout') {
    return iosClassification
  }

  // Fallback: check reason string (works on both iOS and Android)
  if (err.reason === 'Peer removed pairing information') {
    return 'pairing-error'
  }

  return 'connection-error'
}
