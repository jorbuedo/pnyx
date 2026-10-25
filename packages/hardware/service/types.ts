/**
 * Hardware wallet service types.
 *
 * @module
 */

import type {ChainId} from '@pnyx/config'
import type {Logger} from '@pnyx/logger'
import type {Effect, SubscriptionRef} from 'effect'

import type {ConfirmationState, ConfirmationStateManager} from '../confirmation'
import type {LedgerTransportFactory} from '../ledger/types'
import type {
  AppVersion,
  DeviceFeatures,
  DeviceInfo,
  DeviceType,
  HardwareErrorType,
  LedgerConfig,
  TransportType,
  TrezorConfig,
} from '../types'

// ============================================================================
// Trezor UI Request Types
// ============================================================================

/**
 * Discriminated union for Trezor UI requests that surface through service state.
 * Drives PIN/passphrase/button modals at the provider level so they work
 * on any screen, not just the connect screen.
 */
export type TrezorUIRequest =
  | {readonly type: 'pin'; readonly pinType?: 'current' | 'new_first' | 'new_second'}
  | {readonly type: 'invalid_pin'}
  | {readonly type: 'passphrase'}
  | {readonly type: 'button'; readonly code: string}
  | {readonly type: 'pairing_code'}

// ============================================================================
// Types
// ============================================================================

/**
 * WebHID device type for browser environments.
 */
export type HIDDevice = {
  readonly vendorId: number
  readonly productId: number
  readonly productName: string
}

/**
 * Detected hardware device from scanning.
 */
export type DetectedDevice = {
  readonly id: string
  readonly name: string
  readonly type: DeviceType
  readonly transportType: TransportType
  /** Native device descriptor for transport.open() — opaque, only meaningful for USB HID */
  readonly descriptor?: unknown
}

/**
 * Connected hardware device with additional metadata.
 */
export type ConnectedDevice = {
  readonly type: DeviceType
  readonly model: string
  readonly firmwareVersion?: string
  readonly deviceId?: string
  readonly label?: string
  /**
   * BLE device ID for Bluetooth connections (in-memory only).
   * The wallet app persists this in wallet metadata at import time and calls
   * `setReconnectionInfo({deviceType, bleDeviceId})` before sign operations
   * so that the service can auto-reconnect after app restart.
   */
  readonly bleDeviceId?: string
  readonly device: import('../types').HardwareDevice
}

/**
 * Hardware account derived from the device.
 */
export type HardwareAccount = {
  readonly index: number
  readonly path: string
  readonly address: string
  readonly publicKey: Uint8Array
  readonly chainCode: Uint8Array
  readonly balance?: bigint
}

/**
 * Hardware wallet service state.
 */
export type HardwareWalletState = {
  /** Currently connected device, if any */
  readonly connectedDevice: ConnectedDevice | null
  /** Whether we're currently connecting to a device */
  readonly isConnecting: boolean
  /** Whether we're currently scanning for devices */
  readonly isScanning: boolean
  /** Detected devices from scanning */
  readonly detectedDevices: readonly DetectedDevice[]
  /** Current confirmation state for device operations */
  readonly confirmationState: ConfirmationState
  /** Last error that occurred */
  readonly lastError: HardwareErrorType | null
  /** Currently open app name on the device (Ledger only) */
  readonly currentApp: string | null
  /** Active Trezor UI request (PIN/passphrase/button), or null when idle */
  readonly trezorUIRequest: TrezorUIRequest | null
}

/**
 * BLE device for scanning.
 *
 * `vendor` is set by the platform scanner based on the BLE service UUID the
 * device advertised. Used by the service to tag the resulting `DetectedDevice`
 * with the correct `DeviceType` so consumers route to the right pairing flow.
 */
export type BLEDeviceInfo = {
  readonly id: string
  readonly name: string
  readonly rssi?: number
  readonly vendor: DeviceType
}

/**
 * BLE scan subscription for cleanup.
 */
export type BLEScanSubscription = {
  readonly unsubscribe: () => void
}

/**
 * Platform-specific BLE scan function type.
 */
export type PlatformBLEScanFn = (onDevice: (device: BLEDeviceInfo) => void) => BLEScanSubscription

/**
 * A hardware wallet found on the USB bus.
 *
 * `id` is whatever handle that vendor's transport reopens the device with — an
 * Android device path for Trezor, an encoded vendor/product pair for Ledger — so
 * it is opaque here and must round-trip to the platform layer untouched.
 *
 * `vendor` is set by the platform scanner (Trezor and Ledger arrive on separate
 * native rails), mirroring `BLEDeviceInfo.vendor`.
 */
export type UsbDeviceInfo = {
  readonly id: string
  readonly name: string
  readonly vendor: DeviceType
}

/**
 * Platform-specific USB scan (Android host mode).
 *
 * Enumerates what is already plugged in and keeps watching for hot-plug. Whether
 * the USB permission prompt happens during discovery or at connect is a
 * per-vendor detail the platform layer owns.
 */
export type PlatformUsbScanFn = (handlers: {
  readonly onDevice: (device: UsbDeviceInfo) => void
  readonly onDeviceLost?: (id: string) => void
}) => BLEScanSubscription

/**
 * Hardware wallet service configuration.
 */
export type HardwareWalletServiceConfig = {
  /** Trezor manifest configuration */
  readonly trezorManifest?: {
    readonly email: string
    readonly appUrl: string
    readonly appName?: string
  }
  /** Platform-specific BLE scan function (for React Native) */
  readonly platformBLEScan?: PlatformBLEScanFn
  /**
   * Platform-specific USB scan for Trezor (Android). Absent on iOS/web, where
   * USB host mode does not exist — discovery then yields BLE devices only.
   */
  readonly platformUsbScan?: PlatformUsbScanFn
  /**
   * Wait for the BLE adapter to be ready (PoweredOn).
   *
   * Called before any BLE-driven operation (scan, connect, auto-reconnect).
   * Throws a `BluetoothNotReadyError` (from `./index.js`) when the
   * adapter is off, permission was denied, hardware unsupported, or the
   * wait timed out — the UI maps the `reason` to a dedicated modal.
   */
  readonly platformWaitForBluetoothReady?: (timeoutMs?: number) => Promise<void>
  /** Request BLE permissions before scanning (Android needs runtime permissions) */
  readonly platformRequestBLEPermissions?: () => Promise<boolean>
  /**
   * Lazily returns the app's shared `react-native-ble-plx` BleManager so the
   * native Trezor transport connects on the SAME client that ran the pair-screen
   * scan (a peripheral discovered by one manager can't be connected by another).
   * A getter, not the manager itself, so instantiation stays deferred (creating a
   * BleManager on iOS triggers the permission prompt). Returns null on web/where
   * there is no native manager. Typed as `unknown` to keep this config free of
   * the react-native-ble-plx type.
   */
  readonly platformGetBleManager?: () => unknown
  /**
   * Factory to create a platform Ledger transport. Without `prefer`, native
   * Android picks BLE first — which is wrong for a USB-paired Ledger.
   */
  readonly createTransportFactory?: (opts?: {
    readonly prefer?: 'usb' | 'ble'
  }) => Effect.Effect<LedgerTransportFactory, Error>
  /** Create a BLE transport for a specific device by ID (for BLE reconnection) */
  readonly createBLETransportForDevice?: (deviceId: string) => Promise<LedgerTransportFactory>
  /** Check if Bluetooth LE is available on this platform */
  readonly isBLEAvailable?: () => boolean
  /** Check if USB HID is supported on this platform */
  readonly isUSBHIDSupported?: () => boolean
  /** Optional logger instance (falls back to a default silent logger) */
  readonly logger?: Logger
}

/**
 * Core hardware wallet service interface (device lifecycle, no signer methods).
 */
export type HardwareWalletService = {
  /** Current state, observable from React through `useServiceState` */
  readonly state: SubscriptionRef.SubscriptionRef<HardwareWalletState>

  /** Confirmation state manager */
  readonly confirmationManager: ConfirmationStateManager

  /** Get the current state */
  readonly getState: () => Effect.Effect<HardwareWalletState, never>

  // Device Discovery
  /** Scan for available devices */
  readonly scanDevices: () => Effect.Effect<readonly DetectedDevice[], HardwareErrorType>

  /** Start BLE scanning (mobile only) */
  readonly startBLEScan: (onDevice: (device: DetectedDevice) => void) => Effect.Effect<() => void, HardwareErrorType>

  /**
   * Stream Trezors attached over USB (Android only). Cannot fail — a platform
   * without USB host mode just yields no devices.
   */
  readonly startUsbScan: (onDevice: (device: DetectedDevice) => void) => Effect.Effect<() => void, never>

  /** List USB devices (WebHID/USB HID) */
  readonly listUSBDevices: () => Effect.Effect<readonly DetectedDevice[], HardwareErrorType>

  // Connection
  /**
   * Connect to a Ledger device. `userInitiated` clears the
   * intentional-disconnect suppression (set when the user cancels); internal
   * auto-reconnect must omit it so a cancel mid-reconnect isn't wiped by the
   * next retry.
   */
  readonly connectLedger: (
    transportFactory: LedgerTransportFactory,
    config?: Partial<LedgerConfig>,
    bleDeviceId?: string,
    userInitiated?: boolean,
  ) => Effect.Effect<ConnectedDevice, HardwareErrorType>

  /** Connect to a Trezor device. See `connectLedger` for `userInitiated`. */
  readonly connectTrezor: (
    config?: Partial<TrezorConfig>,
    userInitiated?: boolean,
  ) => Effect.Effect<ConnectedDevice, HardwareErrorType>

  /**
   * Disconnect the current device. Pass `{intentional: true}` for a
   * user-initiated teardown (e.g. cancelling a connect modal) so the next
   * device op surfaces the reconnect screen immediately instead of running
   * the silent auto-reconnect cascade against a now-dead BLE handle.
   */
  readonly disconnect: (opts?: {intentional?: boolean}) => Effect.Effect<void, HardwareErrorType>

  /**
   * Send the BOLOS quit-app APDU (Ledger only). Returns the device to the
   * dashboard so the next session starts from a clean firmware state. The
   * transport itself remains open — call `disconnect()` afterwards to also
   * free the BLE slot.
   *
   * No-op on Trezor (no app concept). Best-effort: errors are swallowed.
   */
  readonly quitApp: () => Effect.Effect<void, HardwareErrorType>

  /** Check if a device is connected */
  readonly isConnected: () => boolean

  /** True while a Ledger app switch (`openApp` / `ensureApp`) is in flight. */
  readonly isSwitchingApp: () => boolean

  // Account Operations
  /** Get accounts for a specific chain */
  readonly getAccounts: (
    chain: ChainId,
    count?: number,
    startIndex?: number,
  ) => Effect.Effect<readonly HardwareAccount[], HardwareErrorType>

  /** Get a single account at a specific index */
  readonly getAccount: (chain: ChainId, index: number) => Effect.Effect<HardwareAccount, HardwareErrorType>

  /** Ensure device is connected, correct app is open, and account is cached */
  readonly ensureReady: (chain: ChainId, accountIndex?: number) => Effect.Effect<void, HardwareErrorType>

  /**
   * Seed reconnect state from persisted metadata. `transportHint` is required
   * on Android to keep USB-paired Ledgers off the BLE-first default factory.
   */
  readonly setReconnectionInfo: (info: {
    readonly deviceType: DeviceType
    readonly bleDeviceId?: string
    readonly transportHint?: 'usb' | 'ble'
  }) => void

  // Address Operations
  /** Verify an address on the device display */
  readonly verifyAddress: (
    address: string,
    derivationPath: string,
    chain: ChainId,
  ) => Effect.Effect<boolean, HardwareErrorType>

  // Device Information
  /** Get device information */
  readonly getDeviceInfo: () => Effect.Effect<DeviceInfo, HardwareErrorType>

  /** Get device features */
  readonly getDeviceFeatures: () => Effect.Effect<DeviceFeatures, HardwareErrorType>

  /** Get app version (Ledger only) */
  readonly getAppVersion: () => Effect.Effect<AppVersion, HardwareErrorType>

  /**
   * Open an app on the Ledger device by name. On a recoverable BLE failure
   * (the GATT dropping while the device switches apps) the service reconnects
   * and retries once; pass `allowReconnectOnOpenAppError: false` to opt out.
   */
  readonly openApp: (
    appName: string,
    options?: {readonly allowReconnectOnOpenAppError?: boolean},
  ) => Effect.Effect<void, HardwareErrorType>

  /** Get the current connected device reference (for signer integrations) */
  readonly getCurrentDevice: () => import('../types').HardwareDevice | null

  /** Get the account cache for a specific chain (for signer integrations) */
  readonly getAccountCache: (chain: ChainId) => ReadonlyMap<number, HardwareAccount>

  /** Execute a chain operation with app-not-open error recovery */
  readonly withAppRecovery: <A>(
    chain: ChainId,
    operation: () => Effect.Effect<A, HardwareErrorType>,
  ) => Effect.Effect<A, HardwareErrorType>

  // Trezor UI resolvers — call these from the UI when the user submits PIN/passphrase

  /** Resolve a pending Trezor PIN request with the entered PIN */
  readonly resolveTrezorPin: (pin: string) => void
  /** Reject a pending Trezor PIN request (user cancelled) */
  readonly rejectTrezorPin: () => void
  /** Resolve a pending Trezor passphrase request */
  readonly resolveTrezorPassphrase: (value: string, passphraseOnDevice?: boolean) => void
  /** Reject a pending Trezor passphrase request (user cancelled) */
  readonly rejectTrezorPassphrase: () => void
  /** Resolve a pending Trezor pairing code request with the entered code */
  readonly resolvePairingCode: (code: string) => void
  /** Reject a pending Trezor pairing code request (user cancelled) */
  readonly rejectPairingCode: () => void
}
