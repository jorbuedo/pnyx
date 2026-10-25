/**
 * Hardware wallet types and errors.
 *
 * Provides comprehensive type definitions for hardware wallet integration
 * across Ledger and Trezor devices with multichain support.
 *
 * @module
 */

import {Context, Data, type Effect} from 'effect'

// ============================================================================
// Error Types
// ============================================================================

/**
 * Base error for all hardware wallet operations.
 */
export type LedgerAppRequiredSetting =
  | 'transactionsData'
  | 'customContracts'
  | 'blindSigning'
  | 'blindSigningOrContractData'
  | 'signByHash'

export class HardwareError extends Data.TaggedError('HardwareError')<{
  readonly message: string
  readonly cause?: unknown
  /** The Ledger app that should be used for the failed operation, if known. */
  readonly expectedApp?: string
  /** The Ledger app name associated with the failure, if known. */
  readonly appName?: string
  /** A required Ledger app setting that blocked the operation. */
  readonly requiredSetting?: LedgerAppRequiredSetting
  /** Raw Ledger status code when surfaced by the underlying transport/app. */
  readonly statusCode?: string
}> {}

/**
 * Device is not connected or communication failed.
 */
export class DeviceNotConnectedError extends Data.TaggedError('DeviceNotConnectedError')<{
  readonly deviceType: DeviceType
  readonly message: string
}> {}

/**
 * Bluetooth pairing with the device is no longer valid.
 *
 * Raised on iOS when the peer (Ledger) has removed its bond while the phone
 * still holds stale pairing keys — surfaces from
 * `@ledgerhq/react-native-hw-transport-ble` as `PeerRemovedPairing`
 * (iOS CBError code 14 / reason "Peer removed pairing information").
 * Recovery requires the user to forget the device in the OS Bluetooth
 * settings before re-pairing — simply reconnecting does not help.
 */
export class DevicePairingLostError extends Data.TaggedError('DevicePairingLostError')<{
  readonly deviceType: DeviceType
  readonly message: string
}> {}

/**
 * User rejected the operation on the device.
 */
export class UserRejectedError extends Data.TaggedError('UserRejectedError')<{
  readonly operation: string
}> {}

/**
 * Operation timed out waiting for device response.
 */
export class DeviceTimeoutError extends Data.TaggedError('DeviceTimeoutError')<{
  readonly operation: string
  readonly timeoutMs: number
}> {}

/**
 * Device is locked and requires PIN entry.
 */
export class DeviceLockedError extends Data.TaggedError('DeviceLockedError')<{
  readonly deviceType: DeviceType
}> {}

/**
 * Required app is not open on the device.
 */
export class AppNotOpenError extends Data.TaggedError('AppNotOpenError')<{
  readonly expectedApp: string
  readonly currentApp?: string
}> {}

/**
 * Device firmware or app version is too old.
 */
export class VersionTooOldError extends Data.TaggedError('VersionTooOldError')<{
  readonly current: string
  readonly required: string
  readonly component: 'firmware' | 'app'
}> {}

/**
 * Incorrect device connected (serial number mismatch).
 */
export class IncorrectDeviceError extends Data.TaggedError('IncorrectDeviceError')<{
  readonly expectedSerial: string
  readonly actualSerial: string
}> {}

/**
 * Unknown application name (app not installed on device).
 */
export class UnknownAppError extends Data.TaggedError('UnknownAppError')<{
  readonly appName: string
}> {}

/**
 * Transport layer error (USB/Bluetooth communication failed).
 */
export class TransportError extends Data.TaggedError('TransportError')<{
  readonly transportType: TransportType
  readonly message: string
  readonly cause?: unknown
}> {}

/**
 * Reasons why the BLE adapter is not ready for a hardware-wallet operation.
 *
 * - `off`            — adapter is powered off (user can toggle Bluetooth on)
 * - `unauthorized`   — OS denied Bluetooth permission to the app
 * - `unsupported`    — device hardware lacks Bluetooth (e.g. emulator)
 * - `timeout`        — adapter never reached PoweredOn within the wait window
 */
export type BluetoothNotReadyReason = 'off' | 'unauthorized' | 'unsupported' | 'timeout'

/**
 * BLE adapter is not in a state that allows hardware-wallet communication.
 *
 * Surfaced before initiating a BLE scan or before a BLE auto-reconnect attempt
 * so the UI can show a dedicated modal (Open Settings / wait for adapter) instead
 * of a generic "scan failed" error.
 */
export class BluetoothNotReadyError extends Data.TaggedError('BluetoothNotReadyError')<{
  readonly reason: BluetoothNotReadyReason
  readonly message: string
}> {}

/**
 * Union type of all hardware errors.
 */
export type HardwareErrorType =
  | HardwareError
  | DeviceNotConnectedError
  | DevicePairingLostError
  | UserRejectedError
  | DeviceTimeoutError
  | DeviceLockedError
  | AppNotOpenError
  | VersionTooOldError
  | IncorrectDeviceError
  | UnknownAppError
  | TransportError
  | BluetoothNotReadyError

// ============================================================================
// Device Types
// ============================================================================

/**
 * Supported hardware wallet types.
 */
export type DeviceType = 'ledger' | 'trezor'

/**
 * Ledger device models.
 */
export type LedgerModel = 'nanoS' | 'nanoSPlus' | 'nanoX' | 'nanoGen5' | 'stax' | 'flex'

/**
 * Trezor device models.
 */
export type TrezorModel = 'one' | 'T' | 'safe3' | 'safe5' | 'safe7'

/**
 * Raw internal hardware identifiers returned by Trezor Features.
 */
export type TrezorInternalModel = 'T1B1' | 'T2T1' | 'T2B1' | 'T3B1' | 'T3T1' | 'T3W1'

/**
 * Raw capability values returned by Trezor Features.
 */
export type TrezorRawCapability = string | number

/**
 * Transport type for device communication.
 */
export type TransportType = 'usb' | 'bluetooth' | 'webhid' | 'webusb'

/**
 * Device connection status.
 */
export type DeviceStatus = 'connected' | 'disconnected' | 'locked' | 'busy' | 'app_closed'

/**
 * Information about a connected hardware device.
 */
export type DeviceInfo = {
  /** Device type (ledger/trezor) */
  readonly type: DeviceType
  /** Device model */
  readonly model: string
  /** Device serial number or ID */
  readonly deviceId: string
  /** Firmware version */
  readonly firmwareVersion: string
  /** Current connection status */
  readonly status: DeviceStatus
  /** Transport type used */
  readonly transportType: TransportType
  /** Optional device label (user-set name) */
  readonly label?: string
}

/**
 * Ledger-specific device features.
 */
export type LedgerDeviceFeatures = {
  readonly type: 'ledger'
  readonly model: LedgerModel
  readonly deviceId: string
  readonly firmwareVersion: string
  /** Serial number in hex */
  readonly serialHex: string
  /** USB device descriptor (for USB transport) */
  readonly deviceObj?: {
    readonly vendorId: number
    readonly productId: number
  }
  /** BLE device ID (for Bluetooth transport) */
  readonly bleDeviceId?: string
}

/**
 * Trezor-specific device features.
 */
export type TrezorDeviceFeatures = {
  readonly type: 'trezor'
  readonly model: TrezorModel
  /** Raw internal hardware identifier from Features, when available. */
  readonly internalModel?: TrezorInternalModel
  readonly deviceId: string
  readonly firmwareVersion: string
  /** Raw capabilities from Features, preserved for compatibility decisions/debugging. */
  readonly rawCapabilities: readonly TrezorRawCapability[]
  /** Device label set by user */
  readonly label?: string
  /** Passphrase protection enabled */
  readonly passphraseProtection: boolean
  /** PIN protection enabled */
  readonly pinProtection: boolean
}

/**
 * Union of device features.
 */
export type DeviceFeatures = LedgerDeviceFeatures | TrezorDeviceFeatures

// ============================================================================
// App Types
// ============================================================================

/**
 * Supported blockchain apps on hardware wallets.
 */
export type AppType = 'cardano' | 'ethereum' | 'bitcoin' | 'solana' | 'tron'

/**
 * Chain identifiers accessible via `getChainApp`.
 *
 * Maps user-facing chain names to the underlying hardware app.
 * UTXO variants (litecoin, dogecoin, bitcoin-cash) route to the Bitcoin app
 * with chain-specific configuration.
 */
export type ChainAppType =
  | 'cardano'
  | 'bitcoin'
  | 'litecoin'
  | 'dogecoin'
  | 'bitcoin-cash'
  | 'ethereum'
  | 'solana'
  | 'tron'

/**
 * App version information.
 */
export type AppVersion = {
  readonly name: string
  readonly version: string
  readonly major: number
  readonly minor: number
  readonly patch: number
}

/**
 * Cardano app version capabilities.
 */
export type CardanoAppCapabilities = {
  /** Supports CIP-36 Catalyst voting (version >= 6) */
  readonly cip36: boolean
  /** Supports CIP-1694 governance (version >= 7) */
  readonly cip1694: boolean
  /** Supports CIP-8 message signing */
  readonly cip8: boolean
  /** Supports Plutus scripts */
  readonly plutus: boolean
  /** Supports multisig */
  readonly multisig: boolean
}

// ============================================================================
// Derivation Types
// ============================================================================

/**
 * BIP32 derivation path component.
 */
export type DerivationPathComponent = {
  readonly index: number
  readonly hardened: boolean
}

/**
 * Parsed BIP32 derivation path.
 */
export type DerivationPath = {
  readonly path: string
  readonly components: readonly DerivationPathComponent[]
}

/**
 * Extended public key with chain code.
 */
export type ExtendedPublicKey = {
  /** Raw public key bytes (32 bytes for Ed25519) */
  readonly publicKey: Uint8Array
  /** Chain code for HD derivation (32 bytes) */
  readonly chainCode: Uint8Array
  /** Derivation path */
  readonly derivationPath: string
  /** Device-returned address for chains that use address-level paths (e.g. Tron, Solana) */
  readonly address?: string
}

// ============================================================================
// Signing Types
// ============================================================================

/**
 * CIP-36 Catalyst voter registration parameters.
 * Used to construct on-device voter registration auxiliary data.
 */
export type CIP36RegistrationParams = {
  /** Vote key delegations: array of [voteKeyHex, weight] or a single vote key hex */
  readonly delegations:
    | readonly {readonly voteKeyHex: string; readonly weight: number}[]
    | {readonly voteKeyHex: string}
  /** Staking key derivation path */
  readonly stakingPath: string
  /** Payment address destination for rewards */
  readonly paymentDestination:
    | {readonly type: 'third_party'; readonly addressHex: string}
    | {
        readonly type: 'device_owned'
        readonly addressParams: {readonly spendingPath: string; readonly stakingPath: string}
      }
  /** Registration nonce (slot number) */
  readonly nonce: string
  /** Voting purpose (0 = Catalyst, 1 = other) */
  readonly votingPurpose?: number
}

/**
 * Transaction signing request for Cardano.
 */
export type CardanoSigningRequest = {
  /** Raw transaction CBOR bytes */
  readonly txBodyHashHex: string
  /** Transaction body CBOR hex */
  readonly txBodyHex: string
  /** Required signing paths */
  readonly signingPaths: readonly string[]
  /** Network ID (0 = testnet, 1 = mainnet) */
  readonly networkId: number
  /** Protocol magic (764824073=mainnet, 1=preprod, 2=preview). Defaults to mainnet or preprod based on networkId. */
  readonly protocolMagic?: number
  /** Optional pre-computed public keys keyed by signing path (avoids device round-trip) */
  readonly publicKeys?: Readonly<Record<string, string>>
  /** Optional CIP-36 registration params (Catalyst voting) */
  readonly cip36Registration?: CIP36RegistrationParams
  /**
   * This is one co-signer's share of a native-script spend, so the device must
   * be put in its multisig mode.
   *
   * Stated rather than inferred, because the shape a CIP-1854 spend actually has
   * defeats inference: it carries **one** signing path (our own key) and sets no
   * `required_signers` in the body — the script names the keys, not the body. A
   * device left to guess therefore reads it as an ordinary transaction, and then
   * rejects the 1854 path and extracts no witness path from the script input.
   * The caller always knows: it is spending from a script wallet.
   */
  readonly multisig?: boolean
}

/**
 * Message signing request (CIP-8).
 */
/**
 * CIP-8 address-field parameters for ADDRESS mode message signing.
 *
 * When supplied (with `addressFieldType: 'address'`), the device embeds the
 * full Cardano address — not a bare key hash — into the COSE_Sign1
 * Sig_structure. dApp verifiers (e.g. cardano-foundation verifyDataSignature)
 * compare the protected-header address against the wallet address they
 * requested; a key hash there fails that check. Derivation paths are BIP-32
 * path strings (e.g. `m/1852'/1815'/0'/0/0`).
 */
export type CardanoMessageAddressParams = {
  /** Address shape the device should reconstruct and embed. */
  readonly type: 'base' | 'reward' | 'enterprise'
  /** Payment key path (base/enterprise). */
  readonly spendingPath?: string
  /** Stake key path (base/reward). */
  readonly stakingPath?: string
}

export type MessageSigningRequest = {
  /** Message payload hex */
  readonly payloadHex: string
  /** Signing derivation path */
  readonly signingPath: string
  /** Hash the payload before signing */
  readonly hashPayload: boolean
  /** Prefer hex display on device */
  readonly preferHexDisplay: boolean
  /** Address field type */
  readonly addressFieldType: 'address' | 'keyHash'
  /**
   * Address-field parameters for ADDRESS mode. Required when
   * `addressFieldType` is `'address'`; ignored for `'keyHash'`.
   */
  readonly addressParams?: CardanoMessageAddressParams
  /** Network ID (0 = testnet, 1 = mainnet). Defaults to 1 (mainnet). */
  readonly networkId?: number
  /** Protocol magic (764824073=mainnet, 1=preprod, 2=preview). Defaults to mainnet or preprod based on networkId. */
  readonly protocolMagic?: number
}

/**
 * Signature from a hardware wallet.
 */
export type HardwareSignature = {
  /** Raw signature bytes */
  readonly signature: Uint8Array
  /** Public key that created the signature */
  readonly publicKey: Uint8Array
  /** Derivation path used */
  readonly derivationPath: string
}

/**
 * Transaction witness from hardware signing.
 */
export type TransactionWitness = {
  /** Public key hash hex */
  readonly publicKeyHashHex: string
  /** Signature hex */
  readonly signatureHex: string
  /** Public key hex */
  readonly publicKeyHex: string
  /** CIP-36 auxiliary data supplement (returned when CIP-36 registration is used) */
  readonly auxiliaryDataSupplement?: {
    readonly auxiliaryDataHashHex: string
    readonly cip36VoteRegistrationSignatureHex: string
  }
}

// ============================================================================
// Transport Interface
// ============================================================================

/**
 * Transport layer for hardware device communication.
 *
 * This interface abstracts the underlying transport mechanism
 * (USB, Bluetooth, WebHID, etc.) to provide a platform-agnostic API.
 */
export type Transport = {
  /**
   * Opens the transport connection.
   */
  readonly open: () => Effect.Effect<void, TransportError>

  /**
   * Closes the transport connection.
   */
  readonly close: () => Effect.Effect<void, TransportError>

  /**
   * Sends data to the device and receives a response.
   *
   * @param data - Data to send (APDU for Ledger)
   * @returns Response data from device
   */
  readonly exchange: (data: Uint8Array) => Effect.Effect<Uint8Array, TransportError | DeviceTimeoutError>

  /**
   * Checks if the transport is currently open.
   */
  readonly isOpen: () => boolean

  /**
   * Gets the transport type.
   */
  readonly type: TransportType
}

/**
 * Transport service tag for dependency injection.
 */
export const Transport = Context.GenericTag<Transport>('Transport')

/**
 * Factory for creating transports.
 */
export type TransportFactory = {
  /**
   * Creates a transport for the given device type.
   *
   * @param deviceType - Device type (ledger/trezor)
   * @param options - Transport options
   */
  readonly create: (deviceType: DeviceType, options?: TransportOptions) => Effect.Effect<Transport, TransportError>

  /**
   * Lists available devices.
   */
  readonly list: () => Effect.Effect<readonly DeviceInfo[], TransportError>
}

/**
 * Options for transport creation.
 */
export type TransportOptions = {
  /** Preferred transport type */
  readonly preferredType?: TransportType
  /** Connection timeout in milliseconds */
  readonly timeout?: number
  /** Device ID to connect to (for reconnection) */
  readonly deviceId?: string
}

// ============================================================================
// Hardware Device Interface
// ============================================================================

/**
 * Hardware device interface.
 *
 * Provides a unified API for interacting with hardware wallets
 * regardless of the underlying device type (Ledger/Trezor).
 *
 * Note: All methods use HardwareErrorType to allow implementations
 * to return any hardware-specific error from the error mapping functions.
 */
export type HardwareDevice = {
  /**
   * Gets device information.
   */
  readonly getInfo: () => Effect.Effect<DeviceInfo, HardwareErrorType>

  /**
   * Gets device features.
   */
  readonly getFeatures: () => Effect.Effect<DeviceFeatures, HardwareErrorType>

  /**
   * Connects to the device.
   */
  readonly connect: () => Effect.Effect<void, HardwareErrorType>

  /**
   * Disconnects from the device.
   */
  readonly disconnect: () => Effect.Effect<void, HardwareErrorType>

  /**
   * Checks if the device is connected.
   */
  readonly isConnected: () => boolean

  /**
   * Gets the current app version (for Ledger).
   */
  readonly getAppVersion: () => Effect.Effect<AppVersion, HardwareErrorType>

  /**
   * Gets an extended public key at the given derivation path.
   *
   * @param derivationPath - BIP32 derivation path (e.g., "m/1852'/1815'/0'")
   */
  readonly getExtendedPublicKey: (derivationPath: string) => Effect.Effect<ExtendedPublicKey, HardwareErrorType>

  /**
   * Gets multiple extended public keys in a single batch operation.
   * Prefer this over multiple `getExtendedPublicKey` calls to minimize
   * device round-trips and user confirmation prompts.
   *
   * @param derivationPaths - BIP32 derivation paths
   */
  readonly getExtendedPublicKeys: (
    derivationPaths: readonly string[],
  ) => Effect.Effect<readonly ExtendedPublicKey[], HardwareErrorType>

  /**
   * Signs a Cardano transaction.
   *
   * @param request - Transaction signing request
   */
  readonly signCardanoTransaction: (
    request: CardanoSigningRequest,
  ) => Effect.Effect<readonly TransactionWitness[], HardwareErrorType>

  /**
   * Signs a message (CIP-8).
   *
   * @param request - Message signing request
   */
  readonly signMessage: (request: MessageSigningRequest) => Effect.Effect<HardwareSignature, HardwareErrorType>

  /**
   * Verifies an address on the device display.
   *
   * @param address - Address to verify
   * @param derivationPath - Derivation path for the address
   */
  readonly verifyAddress: (address: string, derivationPath: string) => Effect.Effect<boolean, HardwareErrorType>

  /**
   * Returns the name of the currently running app on the device (Ledger only).
   *
   * Sends the BOLOS "get app and version" APDU (`0xB0 0x01`). Works regardless
   * of which app is open — returns "BOLOS" when on the dashboard.
   *
   * @returns The app name string (e.g., "Cardano ADA", "Ethereum", "BOLOS")
   */
  readonly getRunningAppName?: () => Effect.Effect<string, HardwareErrorType>

  /**
   * Opens an app on the device by name (Ledger only).
   *
   * Sends an APDU command to open the specified app. The user must
   * confirm on the device. Opening an app closes the current one and
   * may reset the transport connection.
   *
   * @param appName - App name as shown on the device (e.g., "Cardano ADA", "Ethereum")
   */
  readonly openApp?: (appName: string) => Effect.Effect<void, HardwareErrorType>

  /**
   * Quits the currently-running chain app and returns the device to the
   * BOLOS dashboard (Ledger only). Sends the BOLOS `quit-app` APDU
   * (`0xB0 0xA7`).
   *
   * Used after a flow that no longer needs the device (e.g. wallet import
   * completion) so the device:
   *   - Doesn't sit on a half-state chain app between sessions, which has
   *     been observed to confuse the next sign attempt on iOS BLE when the
   *     reconnect inherits a stale firmware FSM.
   *   - Lets BOLOS handle clean BLE teardown — `quit-app` triggers an
   *     intentional GATT drop, mirroring Ledger's own session handling.
   *
   * Implemented fire-and-forget on BLE (the GATT drop arrives before the
   * APDU response on iOS @ledgerhq/react-native-hw-transport-ble); swallows
   * errors because failure to quit the app is not a hard failure for the
   * caller.
   */
  readonly quitApp?: () => Effect.Effect<void, HardwareErrorType>

  /**
   * Returns the detected Ledger model, or `null` when the model can't be
   * determined yet (no transport connected, or detection failed).
   *
   * Used by the service layer to pick model-aware BLE timings on the
   * app-switch path — the older Nano X needs materially more time after
   * `openApp` before its BLE advertising restarts than newer Stax/Flex/Gen 5
   * devices. See `packages/hardware/ledger/ble-timings.ts`.
   *
   * Optional — present on Ledger implementations, absent on Trezor.
   */
  readonly getLedgerModel?: () => LedgerModel | null

  /**
   * Gets a chain-specific app wrapper for signing operations.
   *
   * Returns the appropriate app interface for the given chain.
   * The consumer must ensure the correct app is open on the device
   * before calling this (use `openApp()` for Ledger).
   *
   * UTXO variants (litecoin, dogecoin, bitcoin-cash) return a Bitcoin
   * app configured for that chain's currency.
   *
   * @param chain - Chain identifier
   */
  readonly getChainApp: (chain: ChainAppType) => Effect.Effect<unknown, HardwareErrorType>

  /**
   * Updates UI callbacks for PIN, passphrase, and button requests (Trezor only).
   *
   * Allows the service layer to refresh closures after navigation so that
   * UI events during signing are handled by the current screen, not stale
   * connection-time callbacks.
   */
  readonly updateCallbacks?: (callbacks: {
    onPinRequest?: TrezorConfig['onPinRequest']
    onInvalidPin?: TrezorConfig['onInvalidPin']
    onPassphraseRequest?: TrezorConfig['onPassphraseRequest']
    onButtonRequest?: TrezorConfig['onButtonRequest']
  }) => void

  /**
   * Round-trips a small message to the device to verify the transport is
   * actually responsive — distinct from `isConnected()`, which only reports
   * the cached transport-state flag.
   *
   * Trezor: `Ping` protobuf with `button_protection: false` (no on-device
   * prompt). Bypasses the bridge daemon's `GetFeatures` cache, which keeps
   * reporting "alive" even after physical disconnect.
   *
   * Ledger: BOLOS `getAppAndVersion` APDU (`0xB0 0x01 0x00 0x00`). Catches
   * stuck transports (cable plugged but device asleep / app crash / stale
   * BLE bridge session) where `isConnected()` still reports true but APDU
   * calls hang.
   *
   * Optional — implementations that don't override fall back to the cached
   * `isConnected()` flag at the call site.
   */
  readonly pingDevice?: () => Effect.Effect<void, HardwareErrorType>
}

/**
 * Hardware device service tag for dependency injection.
 */
export const HardwareDevice = Context.GenericTag<HardwareDevice>('HardwareDevice')

// ============================================================================
// Configuration Types
// ============================================================================

/**
 * Configuration for Ledger devices.
 */
export type LedgerConfig = {
  readonly type: 'ledger'
  /** Transport options */
  readonly transport?: TransportOptions
  /** Expected serial number (for verification) */
  readonly expectedSerial?: string
  /** Minimum app version required */
  readonly minAppVersion?: string
  /** Operation timeout in milliseconds */
  readonly timeout?: number
  /**
   * How long a USB open-app may wait for the on-device user confirmation
   * before failing with `DeviceTimeoutError`. Defaults to 60s.
   */
  readonly openAppConfirmTimeoutMs?: number
}

/**
 * Configuration for Trezor devices.
 */
export type TrezorConfig = {
  readonly type: 'trezor'
  /** Manifest email (required by Trezor) */
  readonly email: string
  /** Manifest app URL */
  readonly appUrl: string
  /** Manifest app name */
  readonly appName: string
  /** Host name sent to device during THP pairing (defaults to appName if not set) */
  readonly hostName?: string
  /** Expected device ID (for verification) */
  readonly expectedDeviceId?: string
  /** Enable debug mode */
  readonly debug?: boolean
  /** Operation timeout in milliseconds */
  readonly timeout?: number
  /** Logger instance for device-level debug output. When omitted a silent logger is used. */
  readonly logger?: import('@pnyx/logger').Logger
  /** Environment: 'web' for browser, 'node' for Node.js/E2E testing, 'react-native' for mobile */
  readonly env?: 'web' | 'node' | 'react-native'
  /** Transports to use (default: auto-detect). Use ['BridgeTransport'] for emulator testing, or pass pre-instantiated transport objects for React Native */
  readonly transports?: readonly (string | unknown)[]
  /** Native BLE peripheral id of a device already discovered by the caller's scan.
   * When set, connectTrezor connects directly to it and skips its own scan. */
  readonly bleDeviceId?: string
  /** HTTP URL of the Trezor bridge (default port 21328 — node bridge / trezor-user-env).
   * Default when omitted: http://127.0.0.1:21328.
   * Only used when transports includes 'BridgeTransport'. */
  readonly bridgeUrl?: string
  /** Disable WebUSB (useful for Node.js/emulator testing) */
  readonly webusb?: boolean
  /** Called when the device requests PIN entry (older models T1B1, T2T1). Return the PIN string, or reject to cancel. */
  readonly onPinRequest?: (type?: 'current' | 'new_first' | 'new_second') => Promise<string>
  /** Called when PIN entry was invalid. Device allows up to 3 attempts before wiping. */
  readonly onInvalidPin?: () => void
  /** Called when the device requests a passphrase. Return {value, passphraseOnDevice} or reject to cancel. */
  readonly onPassphraseRequest?: () => Promise<{value: string; passphraseOnDevice?: boolean}>
  /** Called when a button confirmation is needed on the device (informational, no response needed). */
  readonly onButtonRequest?: (code: string) => void
  /** Called during THP CodeEntry pairing when user must enter the code shown on the Trezor device. Return the code string. */
  readonly onPairingCode?: (prompt: string) => Promise<string>
  /** Pre-created BLE device API for extension bridge transport (sidepanel contexts where Web Bluetooth is blocked). */
  readonly bleDeviceApi?: unknown
  /** Called after a successful THP pairing to persist credentials for reconnection. */
  readonly onThpCredentialStore?: (
    devicePath: string,
    credentials: ReadonlyArray<{trezor_static_public_key: string; credential: string; host_static_key: string}>,
  ) => Promise<void>
  /** Called before THP handshake to load previously persisted credentials. */
  readonly onThpCredentialLoad?: (
    devicePath: string,
  ) => Promise<Array<{trezor_static_public_key: string; credential: string; host_static_key: string}> | undefined>
}

/**
 * Union of hardware device configurations.
 */
export type HardwareConfig = LedgerConfig | TrezorConfig

// ============================================================================
// Constants
// ============================================================================

/**
 * Minimum supported Ledger Cardano app version.
 */
export const MIN_LEDGER_CARDANO_VERSION = '2.2.1'

/**
 * Ledger Cardano app version that adds CIP-36 support.
 */
export const LEDGER_CIP36_VERSION = 6

/**
 * Ledger Cardano app version that adds CIP-1694 support.
 */
export const LEDGER_CIP1694_VERSION = 7

/**
 * Ledger USB vendor ID.
 */
export const LEDGER_VENDOR_ID = 0x2c97

/**
 * Default operation timeout in milliseconds.
 */
export const DEFAULT_TIMEOUT = 120000
