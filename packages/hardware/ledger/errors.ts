/**
 * Ledger error handling utilities.
 *
 * Maps Ledger-specific error codes and messages to typed errors.
 *
 * @module
 */

import {
  AppNotOpenError,
  DeviceLockedError,
  DeviceNotConnectedError,
  DevicePairingLostError,
  DeviceTimeoutError,
  HardwareError,
  type LedgerAppRequiredSetting,
  TransportError,
  UnknownAppError,
  UserRejectedError,
  VersionTooOldError,
} from '../types'
import {matchesPattern} from '../utils'

/**
 * Ledger device status codes.
 */
export const DeviceStatusCodes = {
  /** Success */
  SUCCESS: 0x9000,
  /** Security status not satisfied (locked device or invalid access rights) */
  ERR_SECURITY_STATUS_NOT_SATISFIED: 0x6982,
  /** User rejected on device */
  ERR_REJECTED_BY_USER: 0x6985,
  /** Ledger OS global error: action refused on device */
  ERR_ACTION_REFUSED: 0x5501,
  /** Ledger OS global error: PIN is not set */
  ERR_PIN_NOT_SET: 0x5502,
  /** Ledger OS global error: device internal error */
  ERR_DEVICE_INTERNAL_ERROR: 0x5223,
  /** CLA not supported (wrong app open) */
  ERR_CLA_NOT_SUPPORTED: 0x6e00,
  /** INS not supported */
  ERR_INS_NOT_SUPPORTED: 0x6d00,
  /** Cardano app not open */
  ERR_CARDANO_APP_NOT_OPEN: 0x6e01,
  /** Device locked */
  ERR_DEVICE_LOCKED: 0x6b0c,
  /** Invalid data */
  ERR_INVALID_DATA: 0x6a80,
  /** Invalid message header (Solana app: malformed transaction header) */
  ERR_INVALID_MESSAGE_HEADER: 0x6a81,
  /** Conditions not satisfied */
  ERR_CONDITIONS_NOT_SATISFIED: 0x6985,
  /** No app name provided (open app command) */
  ERR_NO_APP_NAME: 0x670a,
  /** Unknown application name (app not installed) */
  ERR_UNKNOWN_APP: 0x6807,
  /** Solana app: SDK not supported (used for blind-signing-disabled UI path) */
  ERR_SOLANA_SDK_NOT_SUPPORTED: 0x6808,
  /** Tron app: transaction data is present while Transactions data is disabled */
  ERR_TRON_DATA_NOT_ALLOWED: 0x6a8b,
  /** Tron app: blind signing / sign-by-hash is required but disabled */
  ERR_TRON_SIGN_BY_HASH_NOT_ALLOWED: 0x6a8c,
  /** Tron app: custom contract signing is required but disabled */
  ERR_TRON_CUSTOM_CONTRACT_NOT_ALLOWED: 0x6a8d,
  /** Cardano app: invalid state (stale signing session) */
  ERR_CARDANO_INVALID_STATE: 0x6e06,
  /** Cardano app: invalid data supplied */
  ERR_CARDANO_INVALID_DATA: 0x6e07,
  /** Cardano app: not ready / wrong APDU sequence (e.g. app still initializing after switch) */
  ERR_CARDANO_NOT_READY: 0x6e11,
  /** Ethereum/EVM app: not ready (app in settings screen, pending confirmation, or stale state) */
  ERR_ETH_APP_NOT_READY: 0x6511,
  /**
   * Wrong APDU length / Lc inconsistent with TLV. Surfaced when an APDU is
   * sent before the previous INS chain has been fully consumed, or when the
   * Ledger app is in a state that rejects the framing — typically after a
   * stale session leaves residual bytes in the transport buffer. Recovery
   * requires a full close/reopen cycle to flush state.
   */
  ERR_INVALID_APDU_LENGTH: 0x6a87,
} as const

const formatStatusCode = (code: number): string => `0x${code.toString(16)}`

const LEDGER_APP_SETTING_LABELS: Record<LedgerAppRequiredSetting, string> = {
  transactionsData: 'Transactions data',
  customContracts: 'Custom contracts',
  blindSigning: 'Blind signing',
  blindSigningOrContractData: 'Blind signing or Contract data',
  // The Tron app exposes the same toggle under different names depending on
  // firmware/device — current builds show "Sign by Hash", older ones show
  // "Blind signing". Surface both so the user can find the right one in
  // their Settings menu regardless of version.
  signByHash: 'Sign by Hash or Blind signing',
}

/**
 * Error message patterns for detection.
 */
const errorPatterns = {
  connectionError: [
    'BleError',
    'was disconnected',
    'DisconnectedDevice',
    'DisconnectedDeviceDuringOperation',
    'Cannot write to HID device',
    'cannot open device',
    'device disconnected',
    // @ledgerhq/hw-transport-webhid throws this when its HIDDevice handle closes
    // — a Nano S re-enumerates USB on app switch, closing the old handle.
    'must be opened first',
    // "An action was already pending on the Ledger device. Please deny or
    // reconnect." — @ledgerhq/hw-transport throws this when the transport's
    // atomic exchange lock is still held, e.g. by an abandoned open-app send
    // whose on-device confirmation never came. The handle is poisoned; recovery
    // is a fresh transport, so classify as a connection error.
    'already pending',
  ],
  pairingLost: ['PeerRemovedPairing', 'Peer removed pairing'],
  userRejection: ['rejected by user', 'denied by user', 'action rejected'],
  // 0x6e00 = BOLOS CLA_NOT_SUPPORTED (no app loaded or wrong context).
  // 0x6e02 = chain-app ERR_BAD_CLA — returned when a chain APDU lands on a
  //         different chain app (e.g. Solana APDU while Cardano is open).
  //         Both warrant the same recovery strategy: switch to the target app.
  wrongApp: ['ERR_CLA_NOT_SUPPORTED', '0x6e00', '0x6e02', 'wrong app', 'BAD_CLA'],
  appNotOpen: ['0x6e01', 'cardano app', 'open the app'],
  deviceLocked: ['device is locked', 'locked device', '0x6b0c', '0x5515'],
  timeout: ['timeout', 'timed out', 'TIMEOUT'],
  int64Buffer: ['toBuffer is not a function', 'int64_buffer', 'Uint64BE'],
  transportOpen: ['TransportOpenUserCancelled', 'user cancelled'],
  invalidMessageHeader: ['0x6a81'],
  unknownApp: ['0x6807'],
  invalidState: ['0x6e06', 'invalid state'],
  invalidData: ['0x6e07'],
  notReady: ['0x6e11', '0x6511', '0x6a87'],
  ethereumBlindSigning: [
    'Please enable Blind signing or Contract data in the Ethereum app Settings',
    'Contract data not enabled',
    'Blind signing or Contract data',
  ],
  solanaBlindSigning: ['Blind signing is not enabled', 'blind signing', 'blind sign'],
} as const

/**
 * Checks if an error has a specific status code.
 */
const hasStatusCode = (error: unknown, code: number): boolean => {
  if (error != null && typeof error === 'object') {
    const tagged = error as {statusCode?: unknown}
    if (typeof tagged.statusCode === 'number' && tagged.statusCode === code) {
      return true
    }
    if (typeof tagged.statusCode === 'string') {
      const hexCode = formatStatusCode(code)
      return tagged.statusCode.includes(hexCode) || tagged.statusCode.includes(code.toString())
    }
  }
  if (error instanceof Error) {
    const message = error.message
    return message.includes(formatStatusCode(code)) || message.includes(code.toString())
  }
  return false
}

const getLedgerRequiredSetting = (
  error: unknown,
  operation?: string,
  expectedApp?: string,
): {readonly requiredSetting: LedgerAppRequiredSetting; readonly statusCode?: string} | null => {
  /**
   * Ethereum app / hw-app-eth:
   * upstream ledgerjs remaps status code 0x6a80 to
   * "Please enable Blind signing or Contract data in the Ethereum app Settings"
   * when contract data / arbitrary data signing is disabled.
   *
   * Reference:
   * https://raw.githubusercontent.com/LedgerHQ/ledgerjs/master/packages/hw-app-eth/src/Eth.ts
   */
  if (expectedApp === 'Ethereum' && matchesPattern(error, errorPatterns.ethereumBlindSigning)) {
    return {
      requiredSetting: 'blindSigningOrContractData',
      ...(error instanceof Error && 'statusCode' in error
        ? {}
        : hasStatusCode(error, DeviceStatusCodes.ERR_INVALID_DATA)
          ? {statusCode: formatStatusCode(DeviceStatusCodes.ERR_INVALID_DATA)}
          : {}),
    }
  }

  /**
   * Solana app:
   * upstream firmware shows a blind-signing-disabled UI and returns
   * `ApduReplySdkNotSupported` (0x6808) when blind signing is required but
   * disabled for unrecognized / non-displayable payloads.
   *
   * References:
   * - https://raw.githubusercontent.com/LedgerHQ/app-solana/develop/src/handle_sign_message.c
   * - https://raw.githubusercontent.com/LedgerHQ/app-solana/develop/src/apdu.h
   */
  if (
    expectedApp === 'Solana' &&
    operation?.startsWith('sign Solana') &&
    (matchesPattern(error, errorPatterns.solanaBlindSigning) ||
      hasStatusCode(error, DeviceStatusCodes.ERR_SOLANA_SDK_NOT_SUPPORTED))
  ) {
    return {
      requiredSetting: 'blindSigning',
      ...(hasStatusCode(error, DeviceStatusCodes.ERR_SOLANA_SDK_NOT_SUPPORTED)
        ? {statusCode: formatStatusCode(DeviceStatusCodes.ERR_SOLANA_SDK_NOT_SUPPORTED)}
        : {}),
    }
  }

  if (hasStatusCode(error, DeviceStatusCodes.ERR_TRON_DATA_NOT_ALLOWED)) {
    return {
      requiredSetting: 'transactionsData',
      statusCode: formatStatusCode(DeviceStatusCodes.ERR_TRON_DATA_NOT_ALLOWED),
    }
  }
  /**
   * Tron app:
   * status `0x6a8c` (ERR_TRON_SIGN_BY_HASH_NOT_ALLOWED) is returned when
   * `signByHash` is disabled in the Tron app — required when only the
   * transaction hash is signed (raw protobuf unavailable).
   *
   * The Tron app exposes this exact toggle as "Sign by Hash" in its
   * Settings (NOT "Blind signing", which the Tron app has no concept of).
   *
   * Reference: https://github.com/LedgerHQ/app-tron/blob/develop/src/app_errors.h
   */
  if (hasStatusCode(error, DeviceStatusCodes.ERR_TRON_SIGN_BY_HASH_NOT_ALLOWED)) {
    return {
      requiredSetting: 'signByHash',
      statusCode: formatStatusCode(DeviceStatusCodes.ERR_TRON_SIGN_BY_HASH_NOT_ALLOWED),
    }
  }
  if (hasStatusCode(error, DeviceStatusCodes.ERR_TRON_CUSTOM_CONTRACT_NOT_ALLOWED)) {
    return {
      requiredSetting: 'customContracts',
      statusCode: formatStatusCode(DeviceStatusCodes.ERR_TRON_CUSTOM_CONTRACT_NOT_ALLOWED),
    }
  }
  return null
}

const createLedgerHardwareError = (
  message: string,
  error: unknown,
  options?: {readonly expectedApp?: string; readonly appName?: string; readonly statusCode?: string},
): HardwareError =>
  new HardwareError({
    message,
    ...(options?.expectedApp !== undefined && {expectedApp: options.expectedApp}),
    ...(options?.appName !== undefined && {appName: options.appName}),
    ...(options?.statusCode !== undefined && {statusCode: options.statusCode}),
    cause: error,
  })

const getLedgerOsStatusCode = (error: unknown): string | null => {
  const OS_STATUS_CODES = [
    DeviceStatusCodes.ERR_SECURITY_STATUS_NOT_SATISFIED,
    DeviceStatusCodes.ERR_REJECTED_BY_USER,
    DeviceStatusCodes.ERR_ACTION_REFUSED,
    DeviceStatusCodes.ERR_PIN_NOT_SET,
    DeviceStatusCodes.ERR_DEVICE_INTERNAL_ERROR,
    DeviceStatusCodes.ERR_INS_NOT_SUPPORTED,
    DeviceStatusCodes.ERR_CLA_NOT_SUPPORTED,
    DeviceStatusCodes.ERR_DEVICE_LOCKED,
  ] as const

  for (const code of OS_STATUS_CODES) {
    if (hasStatusCode(error, code)) return formatStatusCode(code)
  }
  return null
}

/**
 * Checks if the error is a connection error.
 */
export const isConnectionError = (error: unknown): boolean => {
  return matchesPattern(error, errorPatterns.connectionError)
}

/**
 * Checks if the error indicates Bluetooth pairing was removed by the peer.
 *
 * Raised by `@ledgerhq/react-native-hw-transport-ble` as `PeerRemovedPairing`
 * when the Ledger side has cleared its bond entry (typical on iOS CBError
 * code 14 / reason "Peer removed pairing information"). Distinct from a
 * generic disconnect — recovery requires the user to forget the stale
 * pairing in OS Bluetooth settings.
 */
export const isPairingLostError = (error: unknown): boolean => {
  if (error instanceof Error && error.name === 'PeerRemovedPairing') return true
  return matchesPattern(error, errorPatterns.pairingLost)
}

/**
 * Checks if the error is a user rejection.
 */
export const isUserRejectionError = (error: unknown): boolean => {
  if (hasStatusCode(error, DeviceStatusCodes.ERR_REJECTED_BY_USER)) {
    return true
  }
  return matchesPattern(error, errorPatterns.userRejection)
}

/**
 * Checks if the error indicates wrong app is open.
 */
export const isWrongAppError = (error: unknown): boolean => {
  if (hasStatusCode(error, DeviceStatusCodes.ERR_CLA_NOT_SUPPORTED)) {
    return true
  }
  return matchesPattern(error, errorPatterns.wrongApp)
}

/**
 * Checks if the error indicates Cardano app is not open.
 */
export const isAppNotOpenError = (error: unknown): boolean => {
  if (hasStatusCode(error, DeviceStatusCodes.ERR_CARDANO_APP_NOT_OPEN)) {
    return true
  }
  return matchesPattern(error, errorPatterns.appNotOpen)
}

/**
 * Checks if the error indicates device is locked.
 */
export const isDeviceLockedError = (error: unknown): boolean => {
  if (hasStatusCode(error, DeviceStatusCodes.ERR_DEVICE_LOCKED)) {
    return true
  }
  return matchesPattern(error, errorPatterns.deviceLocked)
}

/**
 * Checks if the error is a timeout.
 */
export const isTimeoutError = (error: unknown): boolean => {
  return matchesPattern(error, errorPatterns.timeout)
}

/**
 * Checks if the error is related to int64 buffer polyfill issues.
 */
export const isInt64BufferError = (error: unknown): boolean => {
  return matchesPattern(error, errorPatterns.int64Buffer)
}

/**
 * Checks if the error is a transport open cancellation.
 */
export const isTransportCancelledError = (error: unknown): boolean => {
  return matchesPattern(error, errorPatterns.transportOpen)
}

/**
 * Checks if the Solana app returned "invalid message header" (0x6a81).
 * This means the transaction bytes could not be parsed — typically because
 * the full serialized tx (with signature slots) was sent instead of raw message bytes.
 */
export const isInvalidMessageHeaderError = (error: unknown): boolean => {
  if (hasStatusCode(error, DeviceStatusCodes.ERR_INVALID_MESSAGE_HEADER)) {
    return true
  }
  return matchesPattern(error, errorPatterns.invalidMessageHeader)
}

/**
 * Checks if the error indicates an unknown app name.
 */
export const isUnknownAppError = (error: unknown): boolean => {
  if (hasStatusCode(error, DeviceStatusCodes.ERR_UNKNOWN_APP)) {
    return true
  }
  return matchesPattern(error, errorPatterns.unknownApp)
}

/**
 * Checks if the error indicates a stale session or app-not-ready state.
 *
 * Covers Cardano app (0x6e06 / 0x6e07 / 0x6e11), Ethereum/EVM app (0x6511),
 * and generic APDU framing errors (0x6a87) that surface when the transport
 * buffer holds residual bytes from a prior interrupted exchange.
 * These occur when the app is in a stale state (interrupted signing, pending
 * confirmation screen, settings menu open, or still initializing after switch).
 * Recovery: close + reopen the app via openApp() to get a clean state.
 */
export const isStaleSessionError = (error: unknown): boolean => {
  if (
    hasStatusCode(error, DeviceStatusCodes.ERR_CARDANO_INVALID_STATE) ||
    hasStatusCode(error, DeviceStatusCodes.ERR_CARDANO_INVALID_DATA) ||
    hasStatusCode(error, DeviceStatusCodes.ERR_CARDANO_NOT_READY) ||
    hasStatusCode(error, DeviceStatusCodes.ERR_ETH_APP_NOT_READY) ||
    hasStatusCode(error, DeviceStatusCodes.ERR_INVALID_APDU_LENGTH)
  ) {
    return true
  }
  return (
    matchesPattern(error, errorPatterns.invalidState) ||
    matchesPattern(error, errorPatterns.invalidData) ||
    matchesPattern(error, errorPatterns.notReady)
  )
}

/**
 * Map BOLOS OS / device-management command failures (`openApp`, `closeApp`, `getAppAndVersion`).
 *
 * Why this is separate from app-exchange mapping:
 * Ledger's Device Management Kit treats `openApp` as an OS command with only two
 * command-specific errors (`670a`, `6807`) and delegates the rest to the global
 * OS error handler. It also marks `openApp` as `triggersDisconnection = true`,
 * so disconnects after success are expected transport lifecycle changes, not
 * app-exchange failures.
 *
 * References:
 * - https://raw.githubusercontent.com/LedgerHQ/device-sdk-ts/develop/packages/device-management-kit/src/api/command/os/OpenAppCommand.ts
 * - https://raw.githubusercontent.com/LedgerHQ/device-sdk-ts/develop/packages/device-management-kit/src/api/command/os/GetAppAndVersionCommand.ts
 * - https://raw.githubusercontent.com/LedgerHQ/device-sdk-ts/develop/packages/device-management-kit/src/api/command/utils/GlobalCommandError.ts
 * - https://github.com/LedgerHQ/ledger-live/issues/4964
 */
export const mapLedgerOsCommandError = (
  error: unknown,
  operation = 'unknown',
  options?: {readonly appName?: string},
):
  | HardwareError
  | DeviceNotConnectedError
  | DevicePairingLostError
  | UserRejectedError
  | DeviceTimeoutError
  | DeviceLockedError
  | UnknownAppError
  | TransportError => {
  const statusCode = getLedgerOsStatusCode(error) ?? undefined
  const appName = options?.appName

  if (
    hasStatusCode(error, DeviceStatusCodes.ERR_REJECTED_BY_USER) ||
    hasStatusCode(error, DeviceStatusCodes.ERR_ACTION_REFUSED)
  ) {
    return new UserRejectedError({operation})
  }

  if (
    hasStatusCode(error, DeviceStatusCodes.ERR_SECURITY_STATUS_NOT_SATISFIED) ||
    hasStatusCode(error, DeviceStatusCodes.ERR_DEVICE_LOCKED) ||
    isDeviceLockedError(error)
  ) {
    return new DeviceLockedError({deviceType: 'ledger'})
  }

  if (isTimeoutError(error)) {
    return new DeviceTimeoutError({
      operation,
      timeoutMs: 120000,
    })
  }

  if (isPairingLostError(error)) {
    return new DevicePairingLostError({
      deviceType: 'ledger',
      message: error instanceof Error ? error.message : 'Bluetooth pairing removed',
    })
  }

  if (isConnectionError(error)) {
    return new DeviceNotConnectedError({
      deviceType: 'ledger',
      message: error instanceof Error ? error.message : 'Device disconnected',
    })
  }

  if (isTransportCancelledError(error)) {
    return new TransportError({
      transportType: 'usb',
      message: 'User cancelled transport selection',
    })
  }

  if (isUnknownAppError(error)) {
    return new UnknownAppError({appName: appName ?? operation})
  }

  if (hasStatusCode(error, DeviceStatusCodes.ERR_PIN_NOT_SET)) {
    return createLedgerHardwareError('Ledger OS refused the command because PIN is not set on the device.', error, {
      ...(appName !== undefined && {appName}),
      ...(statusCode !== undefined && {statusCode}),
    })
  }

  if (
    hasStatusCode(error, DeviceStatusCodes.ERR_DEVICE_INTERNAL_ERROR) ||
    hasStatusCode(error, DeviceStatusCodes.ERR_CLA_NOT_SUPPORTED) ||
    hasStatusCode(error, DeviceStatusCodes.ERR_INS_NOT_SUPPORTED)
  ) {
    return createLedgerHardwareError(
      `Ledger OS rejected the ${operation} command. This is treated as an OS/device-state failure, not an app-exchange failure.`,
      error,
      {
        ...(appName !== undefined && {appName}),
        ...(statusCode !== undefined && {statusCode}),
      },
    )
  }

  if (isInt64BufferError(error)) {
    return createLedgerHardwareError('Int64 buffer compatibility issue. This may require a polyfill.', error, {
      ...(appName !== undefined && {appName}),
      ...(statusCode !== undefined && {statusCode}),
    })
  }

  return createLedgerHardwareError(error instanceof Error ? error.message : String(error), error, {
    ...(appName !== undefined && {appName}),
    ...(statusCode !== undefined && {statusCode}),
  })
}

/**
 * Map `openApp` failures using Ledger's OS-command semantics.
 *
 * We intentionally do not translate `6e00` into `AppNotOpenError` here. Upstream
 * Ledger code treats `openApp` as a BOLOS command, not an app APDU, and only
 * recognizes `670a` / `6807` as command-specific errors for this path.
 *
 * References:
 * - https://raw.githubusercontent.com/LedgerHQ/device-sdk-ts/develop/packages/device-management-kit/src/api/command/os/OpenAppCommand.ts
 * - https://raw.githubusercontent.com/LedgerHQ/device-sdk-ts/develop/packages/device-management-kit/src/api/command/utils/GlobalCommandError.ts
 */
export const mapLedgerOpenAppError = (
  error: unknown,
  appName: string,
):
  | HardwareError
  | DeviceNotConnectedError
  | DevicePairingLostError
  | UserRejectedError
  | DeviceTimeoutError
  | DeviceLockedError
  | UnknownAppError
  | TransportError => {
  if (hasStatusCode(error, DeviceStatusCodes.ERR_NO_APP_NAME)) {
    return createLedgerHardwareError(
      'Ledger OS rejected the openApp command because no app name was provided.',
      error,
      {
        appName,
        statusCode: formatStatusCode(DeviceStatusCodes.ERR_NO_APP_NAME),
      },
    )
  }

  return mapLedgerOsCommandError(error, 'openApp', {appName})
}

/**
 * Map app-specific APDU failures (`getAddress`, `signTransaction`, etc.).
 *
 * Why this is separate from OS-command mapping:
 * once we are talking to a chain app, status words like `6e00` are often used
 * in practice to mean "wrong app open" / "app command not available in the
 * current app". That is different from the BOLOS `openApp` command semantics.
 *
 * References:
 * - https://tessl.io/registry/tessl/npm-ledgerhq--hw-transport/5.51.0/files/docs/error-handling.md
 * - https://raw.githubusercontent.com/LedgerHQ/ledger-live/64fd193f61866f86bf3839e28220db075312a23d/libs/ledger-live-common/src/hw/openApp.ts
 */
export const mapLedgerAppExchangeError = (
  error: unknown,
  operation = 'unknown',
  expectedApp?: string,
):
  | HardwareError
  | DeviceNotConnectedError
  | DevicePairingLostError
  | UserRejectedError
  | DeviceTimeoutError
  | DeviceLockedError
  | AppNotOpenError
  | UnknownAppError
  | TransportError => {
  const resolvedAppName = expectedApp ?? operation

  // Check for invalid message header (0x6a81, Solana) — the transaction bytes
  // were not parseable by the app firmware (e.g. sent full tx instead of raw message bytes).
  if (isInvalidMessageHeaderError(error)) {
    return createLedgerHardwareError(
      'Invalid transaction format for the Ledger app. The transaction data could not be parsed.',
      error,
      {
        ...(expectedApp !== undefined && {expectedApp}),
      },
    )
  }

  if (isUserRejectionError(error)) {
    return new UserRejectedError({operation})
  }

  if (isUnknownAppError(error)) {
    return new UnknownAppError({appName: resolvedAppName})
  }

  if (isDeviceLockedError(error)) {
    return new DeviceLockedError({deviceType: 'ledger'})
  }

  const requiredSetting = getLedgerRequiredSetting(error, operation, expectedApp)
  if (requiredSetting) {
    const settingLabel = LEDGER_APP_SETTING_LABELS[requiredSetting.requiredSetting]
    return new HardwareError({
      message: `The ${settingLabel} setting must be enabled in the ${resolvedAppName} app on your Ledger.`,
      ...(expectedApp !== undefined && {expectedApp}),
      appName: resolvedAppName,
      requiredSetting: requiredSetting.requiredSetting,
      ...(requiredSetting.statusCode !== undefined && {statusCode: requiredSetting.statusCode}),
      cause: error,
    })
  }

  if (isAppNotOpenError(error) || isWrongAppError(error)) {
    const result: AppNotOpenError = new AppNotOpenError({
      expectedApp: expectedApp ?? 'Cardano',
    })
    if (isWrongAppError(error)) {
      ;(result as {currentApp?: string}).currentApp = 'Unknown'
    }
    return result
  }

  if (isTimeoutError(error)) {
    return new DeviceTimeoutError({
      operation,
      timeoutMs: 120000,
    })
  }

  if (isPairingLostError(error)) {
    return new DevicePairingLostError({
      deviceType: 'ledger',
      message: error instanceof Error ? error.message : 'Bluetooth pairing removed',
    })
  }

  if (isConnectionError(error)) {
    return new DeviceNotConnectedError({
      deviceType: 'ledger',
      message: error instanceof Error ? error.message : 'Device disconnected',
    })
  }

  if (isTransportCancelledError(error)) {
    return new TransportError({
      transportType: 'usb',
      message: 'User cancelled transport selection',
    })
  }

  if (isInt64BufferError(error)) {
    return createLedgerHardwareError('Int64 buffer compatibility issue. This may require a polyfill.', error, {
      ...(expectedApp !== undefined && {expectedApp}),
    })
  }

  return createLedgerHardwareError(error instanceof Error ? error.message : String(error), error, {
    ...(expectedApp !== undefined && {expectedApp}),
  })
}

/**
 * Backwards-compatible alias for the previous single-path mapper.
 *
 * New call sites should prefer `mapLedgerOpenAppError()` for BOLOS app
 * management and `mapLedgerOsCommandError()` for `getAppAndVersion`-style
 * commands. App-exchange commands should use this mapper.
 */
export const mapLedgerError = mapLedgerAppExchangeError

/**
 * Parses a version string into components.
 *
 * @param version - Version string (e.g., "2.2.1")
 * @returns Version components or null if invalid
 */
export const parseVersion = (version: string): {major: number; minor: number; patch: number} | null => {
  const parts = version.split('.')
  if (parts.length < 2) return null

  const major = parseInt(parts[0] ?? '0', 10)
  const minor = parseInt(parts[1] ?? '0', 10)
  const patch = parseInt(parts[2] ?? '0', 10)

  if (Number.isNaN(major) || Number.isNaN(minor) || Number.isNaN(patch)) return null

  return {major, minor, patch}
}

/**
 * Compares two version strings.
 *
 * @param a - First version
 * @param b - Second version
 * @returns -1 if a < b, 0 if a == b, 1 if a > b
 */
export const compareVersions = (a: string, b: string): number => {
  const va = parseVersion(a)
  const vb = parseVersion(b)

  if (!va || !vb) return 0

  if (va.major !== vb.major) return va.major < vb.major ? -1 : 1
  if (va.minor !== vb.minor) return va.minor < vb.minor ? -1 : 1
  if (va.patch !== vb.patch) return va.patch < vb.patch ? -1 : 1

  return 0
}

/**
 * Checks if a version meets the minimum requirement.
 *
 * @param version - Version to check
 * @param minVersion - Minimum required version
 * @returns True if version >= minVersion
 */
export const meetsMinimumVersion = (version: string, minVersion: string): boolean => {
  return compareVersions(version, minVersion) >= 0
}

/**
 * Validates the Ledger Cardano app version.
 *
 * @param version - App version string
 * @param minVersion - Minimum required version
 * @returns Error if version is too old, undefined otherwise
 */
export const validateAppVersion = (version: string, minVersion: string): VersionTooOldError | undefined => {
  if (!meetsMinimumVersion(version, minVersion)) {
    return new VersionTooOldError({
      current: version,
      required: minVersion,
      component: 'app',
    })
  }
  return undefined
}
