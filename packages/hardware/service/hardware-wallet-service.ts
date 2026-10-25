/**
 * Core hardware wallet service implementation.
 *
 * Provides device lifecycle management (connect, disconnect, scan, accounts)
 * for Ledger and Trezor hardware wallets. Signer methods are NOT included here
 * — they live in the wallet app as a thin extension layer since @pnyx/signer
 * depends on ./index.js.
 *
 * @module
 */

import {type ChainId, SOLANA_MAINNET, TRON_MAINNET} from '@pnyx/config'
import {createLogger} from '@pnyx/logger'
import {Context, Duration, Effect, Layer, pipe, Ref, Schedule, SubscriptionRef} from 'effect'

import {createConfirmationStateManager} from '../confirmation'
import {getAccountPath, getAddressPath} from '../derivation/service-paths'
import {solanaLedgerPath} from '../derivation/solana'
import {getBleSwitchTimings} from '../ledger/ble-timings'
import {getAppForChain} from '../ledger/chains'
import {createLedgerDevice} from '../ledger/device'
import {isAppNotOpenError, isStaleSessionError, isWrongAppError} from '../ledger/errors'
import type {LedgerTransportFactory} from '../ledger/types'
import {createTrezorDevice} from '../trezor/device'
import type {DeviceType, HardwareDevice, HardwareErrorType, LedgerConfig, TrezorConfig} from '../types'
import {AppNotOpenError, BluetoothNotReadyError, DeviceNotConnectedError, HardwareError} from '../types'
import {createAppSwitchGuard} from './app-switch-guard'
import {probeLedgerAppOpen} from './ledger-app-probe'
import type {
  ConnectedDevice,
  DetectedDevice,
  HardwareAccount,
  HardwareWalletService,
  HardwareWalletServiceConfig,
  HardwareWalletState,
  HIDDevice,
} from './types'

// ============================================================================
// State Management
// ============================================================================

/**
 * Create initial hardware wallet service state.
 */
const createInitialState = (): HardwareWalletState => ({
  connectedDevice: null,
  isConnecting: false,
  isScanning: false,
  detectedDevices: [],
  confirmationState: {type: 'idle'},
  lastError: null,
  currentApp: null,
  trezorUIRequest: null,
})

// ============================================================================
// Constants
// ============================================================================

/**
 * Default Trezor manifest for the wallet app.
 * Can be overridden via HardwareWalletServiceConfig.trezorManifest.
 */
const FALLBACK_TREZOR_MANIFEST = {
  email: 'support@pxkq.uk',
  appUrl: 'https://pnyx.pxkq.uk',
  appName: 'Pnyx',
}

export type LedgerAppRecoveryStrategy = 'none' | 'retry' | 'force-reopen'

const isTaggedAppNotOpenError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  '_tag' in error &&
  (error as {_tag?: unknown})._tag === 'AppNotOpenError'

export const resolveLedgerAppRecoveryStrategy = (error: unknown): LedgerAppRecoveryStrategy => {
  if (isStaleSessionError(error)) return 'force-reopen'
  if (isTaggedAppNotOpenError(error) || isAppNotOpenError(error) || isWrongAppError(error)) return 'retry'
  return 'none'
}

export const shouldReconnectAfterOpenAppError = (error: unknown): boolean => {
  const recoveryStrategy = resolveLedgerAppRecoveryStrategy(error)
  if (recoveryStrategy === 'retry' || recoveryStrategy === 'force-reopen') return true

  if (typeof error === 'object' && error !== null && '_tag' in error) {
    const tagged = error as {_tag?: unknown}
    return tagged._tag === 'DeviceNotConnectedError' || tagged._tag === 'TransportError'
  }

  return false
}

export const getExpectedAccountCachePath = (
  chain: ChainId,
  accountIndex: number,
  deviceType?: DeviceType | null,
): string => {
  if (chain === SOLANA_MAINNET && deviceType === 'ledger') {
    return solanaLedgerPath(accountIndex)
  }
  if (chain === TRON_MAINNET || chain === SOLANA_MAINNET) {
    return getAddressPath(chain, accountIndex, 0, deviceType ?? undefined)
  }
  return getAccountPath(chain, accountIndex)
}

export const isHardwareAccountCacheEntryCompatible = (
  account: Pick<HardwareAccount, 'path'> | null | undefined,
  chain: ChainId,
  accountIndex: number,
  deviceType?: DeviceType | null,
): boolean => account?.path === getExpectedAccountCachePath(chain, accountIndex, deviceType)

export const getAccountCacheKey = (chain: ChainId, accountIndex: number): string => `${chain}:${accountIndex}`

/**
 * Decide whether the generic platform transport factory must be skipped for
 * a Ledger reconnect attempt.
 *
 * BLE Ledgers can't be silently re-attached by the generic factory — they
 * need a concrete device ID. USB Ledgers can re-attach via TransportHID.list
 * / open, so the generic factory should run for them. On Android the factory
 * defaults to BLE-first; without a hint this misroutes USB-paired Ledgers.
 */
/** After a Ledger DeviceLockedError, the USB HID transport keeps a
 *  pending-action marker that surfaces "An action was already pending on
 *  the Ledger device" on retry until app hard-close. Force a transport
 *  reset on USB; BLE recovers cleanly on its own. */
export const shouldResetTransportOnLockedDevice = (transportHint: 'usb' | 'ble' | null): boolean =>
  transportHint === 'usb'

/**
 * APDU-layer errors that indicate the device transport is in a transient
 * state mismatch — e.g. the user just unlocked the Ledger, the OS HID
 * descriptor is still settling, and our BOLOS probe lands before the
 * device is ready to respond. Surfaced by `LedgerHelper.unwrapResponseAPDU`
 * on Android USB as "Invalid sequence". Distinct from a genuine
 * `DeviceLockedError` (caught by `_tag`) and from a half-open BLE notify
 * (recovered by cycling transport). Worth one short settle-and-retry
 * before falling through to the app-specific probe.
 *
 * Match shape: message starts with "Invalid sequence" or "Invalid channel"
 * (optionally followed by a colon and detail bytes). Anchored — loose
 * substring matching risked false positives on wrapped/composed errors
 * carrying user-supplied context.
 */
const TRANSIENT_APDU_PATTERN = /^Invalid (sequence|channel)(:|$|\s)/i

export const isTransientApduError = (message: string | undefined): boolean => {
  if (!message) return false
  return TRANSIENT_APDU_PATTERN.test(message.trim())
}

export const shouldSkipGenericLedgerReconnect = (input: {
  readonly deviceType: 'ledger' | 'trezor' | null
  readonly isBLEAvailable: boolean
  readonly transportHint: 'usb' | 'ble' | null
  readonly hasBleDeviceId: boolean
}): boolean =>
  input.deviceType === 'ledger' && input.isBLEAvailable && (input.transportHint === 'ble' || input.hasBleDeviceId)

/** How long a Trezor reconnect may make no progress before the scan fallback takes over. */
const TREZOR_RECONNECT_STALL_MS = 5_000

/** How often the stall detector checks whether the device has asked the user for something. */
const TREZOR_STALL_POLL_MS = 250

/**
 * The `transports` filter a Trezor reconnect must carry.
 *
 * ⚠️ `lastTrezorConfig` is in-memory only — it is populated by a successful
 * `connectTrezor`, so it is `undefined` for the first hardware operation after
 * launch. An absent filter means `wantUsb` is true, and the Android arm picks
 * USB before BLE: a cold-start reconnect to a BLE-paired Trezor enumerated USB,
 * found nothing, and failed with "No Trezor devices found" without ever opening
 * the radio. `lastTransportHint` / `lastBleDeviceId` survive a launch (seeded
 * from the stored credential) and are the only knowledge of the pairing there
 * is, so the reconnect states it rather than letting auto-detect guess.
 *
 * Only the positive BLE signal is acted on: a caller-supplied filter wins, and
 * a USB-hinted device keeps auto-detect, whose per-platform order is already
 * right for a cable.
 */
export const trezorReconnectTransports = (input: {
  readonly configured: readonly (string | unknown)[] | undefined
  readonly transportHint: 'usb' | 'ble' | null
  readonly hasBleDeviceId: boolean
}): readonly (string | unknown)[] | undefined =>
  input.configured ?? (input.transportHint === 'ble' || input.hasBleDeviceId ? ['NativeBluetoothTransport'] : undefined)

export const resolveSeededLedgerTransportState = (info: {
  readonly bleDeviceId?: string
  readonly transportHint?: 'usb' | 'ble'
}): {
  readonly bleDeviceId: string | null
  readonly transportHint: 'usb' | 'ble' | null
} => ({
  bleDeviceId: info.bleDeviceId ?? null,
  // Legacy meta records (paired before `transportHint` was persisted) carry
  // neither a hint nor a BLE id when the device was USB. Without a positive
  // signal the platform factory defaults to BLE on Android, reproducing the
  // exact same symptom for already-paired users. Treat absent-both as
  // USB so the cold-start reconnect picks the right transport without a
  // re-pair migration.
  transportHint: info.transportHint ?? (info.bleDeviceId ? 'ble' : 'usb'),
})

export const filterAccountCacheByChain = (
  cache: ReadonlyMap<string, HardwareAccount>,
  chain: ChainId,
): Map<number, HardwareAccount> => {
  const result = new Map<number, HardwareAccount>()
  for (const [key, account] of cache) {
    if (!key.startsWith(`${chain}:`)) continue
    result.set(account.index, account)
  }
  return result
}

// ============================================================================
// Service Implementation
// ============================================================================

/**
 * HardwareWalletService context tag for dependency injection.
 */
export const HardwareWalletServiceTag = Context.GenericTag<HardwareWalletService>('HardwareWalletService')

/**
 * Create the core hardware wallet service.
 */
export const createHardwareWalletService = (
  config: HardwareWalletServiceConfig = {},
): Effect.Effect<HardwareWalletService, never> =>
  Effect.gen(function* () {
    const logger = config.logger ?? createLogger()
    logger.debug('Creating hardware wallet service', {
      origin: 'HardwareWalletService',
    })

    // Merge caller-provided manifest with fallback defaults
    const defaultManifest = config.trezorManifest
      ? {
          email: config.trezorManifest.email,
          appUrl: config.trezorManifest.appUrl,
          appName: config.trezorManifest.appName ?? FALLBACK_TREZOR_MANIFEST.appName,
        }
      : FALLBACK_TREZOR_MANIFEST

    // Create state ref
    const state = yield* SubscriptionRef.make<HardwareWalletState>(createInitialState())

    // Track current device
    let currentDevice: HardwareDevice | null = null

    // Cache account xpubs for child key derivation during signing.
    // Keyed by chain + account index because different chains legitimately reuse
    // the same numeric account index with different derivation paths/xpubs.
    let accountCache = new Map<string, HardwareAccount>()

    // Reconnection state: stored so ensureConnected can reconnect after session loss
    let lastTransportFactory: LedgerTransportFactory | null = null
    let lastLedgerConfig: Partial<LedgerConfig> | undefined
    let lastTrezorConfig: Partial<TrezorConfig> | undefined
    let lastDeviceType: DeviceType | null = null
    let lastBleDeviceId: string | null = null
    let lastTransportHint: 'usb' | 'ble' | null = null
    let bleDisconnectCleanup: (() => void) | null = null
    // Set when the user explicitly tears down the device (cancel). Suppresses
    // the auto-reconnect cascade on the next op so we fast-fail to the reconnect
    // screen instead of spinning ~40s against the dead BLE handle. Cleared by any
    // user-initiated connect.
    let intentionalDisconnect = false

    const appSwitchGuard = createAppSwitchGuard()
    const withAppSwitchGuard = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      Effect.acquireUseRelease(
        Effect.sync(() => appSwitchGuard.enter()),
        () => effect,
        () => Effect.sync(() => appSwitchGuard.exit()),
      )

    // BOLOS ping debounce. `hasHealthyConnection` used to
    // fire a redundant BOLOS round-trip every time `ensureConnected` was
    // called from within a nested call path. The cache short-circuits the
    // ping when any BOLOS probe succeeded within PROBE_CACHE_TTL_MS — recent
    // success is sufficient proof the device is alive.
    //
    // NOTE: this cache only debounces the alive-check. It does NOT cache
    // the running app name — that probe stays in `ensureApp` for every
    // call because the user can manually switch apps on the device and
    // dispatching a chain APDU to the wrong app produces a wrong-chain
    // signature that the broadcast path cannot recover from.
    //
    // Invalidated on connect / disconnect / transport drop so a stale
    // timestamp can never make us skip a probe on a dead transport.
    const PROBE_CACHE_TTL_MS = 1_000
    let lastProbeAtMs = 0
    const invalidateProbeCache = (): void => {
      lastProbeAtMs = 0
    }

    // Trezor UI callback pending resolve/reject refs
    let pinResolve: ((pin: string) => void) | null = null
    let pinReject: (() => void) | null = null
    let passphraseResolve: ((result: {value: string; passphraseOnDevice?: boolean}) => void) | null = null
    let passphraseReject: (() => void) | null = null
    let pairingCodeResolve: ((code: string) => void) | null = null
    let pairingCodeReject: (() => void) | null = null

    /** Timeout for PIN/passphrase modals (5 minutes) */
    const UI_TIMEOUT_MS = 5 * 60 * 1000

    const updateState = (updater: (prev: HardwareWalletState) => HardwareWalletState): Effect.Effect<void, never> =>
      SubscriptionRef.update(state, updater)

    // Create confirmation state manager with callbacks
    const confirmationManager = createConfirmationStateManager({
      onStateChange: (confirmationState) => {
        const messageKey = 'messageKey' in confirmationState ? String(confirmationState.messageKey ?? '-') : '-'
        logger.info('Confirmation state changed', {
          origin: 'HardwareWalletService',
          stateType: confirmationState.type,
          messageKey,
        })
        Effect.runSync(updateState((s) => ({...s, confirmationState})))
      },
    })

    const getState = (): Effect.Effect<HardwareWalletState, never> => SubscriptionRef.get(state)

    const toBluetoothReadinessError = (error: unknown): HardwareErrorType => {
      if (error instanceof BluetoothNotReadyError) return error
      return new HardwareError({
        message: `Bluetooth readiness check failed: ${error instanceof Error ? error.message : String(error)}`,
        cause: error,
      })
    }

    const waitForBleReady = (timeoutMs: number): Effect.Effect<void, HardwareErrorType> =>
      Effect.tryPromise({
        try: () => config.platformWaitForBluetoothReady?.(timeoutMs) ?? Promise.resolve(),
        catch: toBluetoothReadinessError,
      })

    const requestBleScanPermissions = (): Effect.Effect<void, HardwareErrorType> =>
      Effect.gen(function* () {
        if (!config.platformRequestBLEPermissions) return

        const granted = yield* Effect.tryPromise({
          try: () => config.platformRequestBLEPermissions?.() ?? Promise.resolve(true),
          catch: (error) =>
            new HardwareError({
              message: `Bluetooth permission request failed: ${error instanceof Error ? error.message : String(error)}`,
              cause: error,
            }),
        })

        if (!granted) {
          return yield* Effect.fail(
            new BluetoothNotReadyError({
              reason: 'unauthorized',
              message: 'BLE runtime permissions were denied',
            }),
          )
        }
      })

    const scanDevices = (): Effect.Effect<readonly DetectedDevice[], HardwareErrorType> =>
      Effect.gen(function* () {
        yield* updateState((s) => ({
          ...s,
          isScanning: true,
          lastError: null,
        }))

        try {
          // Try WebHID first (browser extension)
          const devices: DetectedDevice[] = []

          // Check for WebHID support
          if (typeof navigator !== 'undefined' && 'hid' in navigator) {
            const hidDevices = yield* Effect.tryPromise({
              try: async () => {
                const hid = (
                  navigator as Navigator & {
                    hid: {getDevices: () => Promise<HIDDevice[]>}
                  }
                ).hid
                return hid.getDevices()
              },
              catch: (error) =>
                new HardwareError({
                  message: `Failed to list HID devices: ${error instanceof Error ? error.message : String(error)}`,
                  cause: error,
                }),
            })

            // Filter for Ledger devices (vendor ID 0x2c97)
            for (const device of hidDevices) {
              if (device.vendorId === 0x2c97) {
                devices.push({
                  id: `${device.vendorId}:${device.productId}`,
                  name: device.productName || 'Ledger Device',
                  type: 'ledger',
                  transportType: 'webhid',
                })
              }
            }
          }

          yield* updateState((s) => ({
            ...s,
            isScanning: false,
            detectedDevices: devices,
          }))
          return devices
        } catch (error) {
          const hwError =
            error instanceof HardwareError
              ? error
              : new HardwareError({
                  message: `Device scan failed: ${error instanceof Error ? error.message : String(error)}`,
                  cause: error,
                })
          yield* updateState((s) => ({
            ...s,
            isScanning: false,
            lastError: hwError,
          }))
          return yield* Effect.fail(hwError)
        }
      })

    const startBLEScan = (onDevice: (device: DetectedDevice) => void): Effect.Effect<() => void, HardwareErrorType> =>
      Effect.gen(function* () {
        yield* updateState((s) => ({
          ...s,
          isScanning: false,
          lastError: null,
        }))

        // Permission and readiness are gated independently — either platform hook
        // can be wired without the other, and each surfaces a distinct
        // `BluetoothNotReadyError` reason the UI maps to its own modal copy.
        if (config.platformRequestBLEPermissions) {
          yield* requestBleScanPermissions().pipe(
            Effect.tapError((e) => updateState((s) => ({...s, isScanning: false, lastError: e}))),
          )
        }
        if (config.platformWaitForBluetoothReady) {
          yield* waitForBleReady(10_000).pipe(
            Effect.tapError((e) => updateState((s) => ({...s, isScanning: false, lastError: e}))),
          )
        }

        yield* updateState((s) => ({...s, isScanning: true}))

        // Use platform-specific BLE scan if provided
        if (config.platformBLEScan) {
          const subscription = config.platformBLEScan((bleDevice) => {
            const detected: DetectedDevice = {
              id: bleDevice.id,
              name: bleDevice.name,
              type: bleDevice.vendor,
              transportType: 'bluetooth',
            }
            onDevice(detected)
          })

          return () => {
            subscription.unsubscribe()
            Effect.runSync(updateState((s) => ({...s, isScanning: false})))
          }
        }

        // Fallback warning for platforms without BLE support
        logger.warn('BLE scanning not available on this platform', {
          origin: 'HardwareWalletService',
        })

        return () => {
          Effect.runSync(updateState((s) => ({...s, isScanning: false})))
        }
      })

    /**
     * Stream Trezors attached over USB (Android host mode).
     *
     * Nothing is "scanned" — the OS already knows what is plugged in, so this
     * enumerates immediately and then tracks hot-plug. Unlike the BLE scan there
     * is no adapter to warm up and no radio left running, so it never fails: a
     * platform without USB host mode simply yields no devices.
     */
    const startUsbScan = (onDevice: (device: DetectedDevice) => void): Effect.Effect<() => void, never> =>
      Effect.sync(() => {
        if (!config.platformUsbScan) {
          logger.debug('USB scanning not available on this platform', {
            origin: 'HardwareWalletService',
          })
          return () => {}
        }

        const subscription = config.platformUsbScan({
          onDevice: (usbDevice) => {
            onDevice({
              id: usbDevice.id,
              name: usbDevice.name,
              type: usbDevice.vendor,
              transportType: 'usb',
            })
          },
        })

        return () => subscription.unsubscribe()
      })

    const listUSBDevices = (): Effect.Effect<readonly DetectedDevice[], HardwareErrorType> => scanDevices()

    const connectLedger = (
      transportFactory: LedgerTransportFactory,
      ledgerCfg?: Partial<LedgerConfig>,
      bleDeviceId?: string,
      userInitiated = false,
    ): Effect.Effect<ConnectedDevice, HardwareErrorType> =>
      Effect.gen(function* () {
        // Only a user-initiated connect ends the cancel suppression. Internal
        // auto-reconnect (which retries connectLedger 1s/2s/4s apart) must not
        // clear it — a cancel landing between retries would otherwise be wiped.
        if (userInitiated) intentionalDisconnect = false
        yield* updateState((s) => ({
          ...s,
          isConnecting: true,
          lastError: null,
        }))

        // State-first teardown of any previous device. On iOS BLE,
        // transport.close() can hang indefinitely when the GATT is half-open
        // — exactly the state left behind when the first attempt timed out
        // against a locked Ledger. Awaiting the old close before clearing
        // currentDevice (as the previous flow did) pinned the retry path
        // forever: tapping "Try again" on the Connection Failed modal did
        // nothing because this gen stalled before reaching createLedgerDevice.
        // Drop the reference first, then best-effort close with a hard cap.
        if (currentDevice) {
          const deviceToClose = currentDevice
          currentDevice = null
          yield* Effect.either(
            deviceToClose.disconnect().pipe(
              Effect.timeoutFail({
                duration: Duration.seconds(2),
                onTimeout: () =>
                  new HardwareError({
                    message: 'transport.close() timed out (ignored)',
                  }),
              }),
            ),
          )
        }
        // Cached xpubs are session-scoped. Clear them before every new connection
        // attempt so Cardano signing cannot reuse account data from another chain
        // or a previously connected device.
        accountCache = new Map()
        invalidateProbeCache()

        const ledgerConfig: LedgerConfig = {
          type: 'ledger',
          ...ledgerCfg,
        }

        try {
          const device = createLedgerDevice(transportFactory, ledgerConfig)
          currentDevice = device

          // Connect to the device with timeout (establishes transport only, no app required).
          // BLE connections are flaky right after scan stops — the OS BLE stack may not be
          // ready for a GATT connection yet. Retry up to 2 times with a 1s delay.
          logger.debug('Connecting to Ledger device...', {
            origin: 'HardwareWalletService',
          })
          yield* device.connect().pipe(
            Effect.timeoutFail({
              duration: Duration.seconds(10),
              onTimeout: () =>
                new HardwareError({
                  message: 'Connection timed out. Make sure your Ledger is unlocked and connected.',
                }),
            }),
            Effect.retry(
              Schedule.compose(
                Schedule.recurs(2),
                Schedule.addDelay(Schedule.forever, () => Duration.seconds(1)),
              ),
            ),
          )

          // Store transport/config for reconnection only AFTER successful connection.
          // This prevents ensureConnected from reusing a factory that already failed.
          lastTransportFactory = transportFactory
          lastLedgerConfig = ledgerCfg
          lastDeviceType = 'ledger'
          if (bleDeviceId) lastBleDeviceId = bleDeviceId
          // Persist the transport kind so a cold-start `ensureConnected`
          // picks the right transport instead of defaulting to BLE on
          // Android USB-paired Ledgers. Only write when we have a positive
          // signal: a BLE device id (definitely BLE) or no prior hint at
          // all (first pair via a USB factory). The internal reconnect
          // path calls `connectLedger(factory, config)` without a
          // `bleDeviceId` even on BLE — flipping the hint to USB there
          // would break `shouldResetTransportOnLockedDevice`'s BLE
          // exemption and trigger an unnecessary transport reset.
          // Truthy check (not `!== undefined`) so an empty string id —
          // which line 491 above also skips — doesn't flip the hint to BLE
          // while `lastBleDeviceId` stays unset.
          if (bleDeviceId) {
            lastTransportHint = 'ble'
          } else if (lastTransportHint === null) {
            lastTransportHint = 'usb'
          }

          // Get device info for model display name (firmware/deviceId may be empty until an app is opened)
          const info = yield* device.getInfo()

          const connectedDevice: ConnectedDevice = {
            type: 'ledger',
            model: info.model,
            ...(info.firmwareVersion ? {firmwareVersion: info.firmwareVersion} : {}),
            ...(info.deviceId ? {deviceId: info.deviceId} : {}),
            ...(info.label !== undefined ? {label: info.label} : {}),
            ...(bleDeviceId ? {bleDeviceId} : {}),
            device,
          }

          yield* updateState((s) => ({
            ...s,
            isConnecting: false,
            connectedDevice,
          }))

          logger.info('Ledger connected', {
            origin: 'HardwareWalletService',
            model: info.model,
          })

          return connectedDevice
        } catch (error) {
          const hwError =
            error instanceof HardwareError
              ? error
              : new HardwareError({
                  message: `Ledger connection failed: ${error instanceof Error ? error.message : String(error)}`,
                  cause: error,
                })
          yield* updateState((s) => ({
            ...s,
            isConnecting: false,
            lastError: hwError,
          }))
          return yield* Effect.fail(hwError)
        }
      })

    const connectTrezor = (
      trezorCfg?: Partial<TrezorConfig>,
      userInitiated = false,
    ): Effect.Effect<ConnectedDevice, HardwareErrorType> =>
      Effect.gen(function* () {
        if (userInitiated) intentionalDisconnect = false
        yield* updateState((s) => ({
          ...s,
          isConnecting: true,
          lastError: null,
        }))

        // State-first teardown — match the connectLedger / disconnect flow so
        // a hung native close (BLE half-open, USB interface stuck) cannot pin
        // the retry path. Drop the reference first, then best-effort close.
        if (currentDevice) {
          const deviceToClose = currentDevice
          currentDevice = null
          yield* Effect.either(
            deviceToClose.disconnect().pipe(
              Effect.timeoutFail({
                duration: Duration.seconds(2),
                onTimeout: () =>
                  new HardwareError({
                    message: 'transport.close() timed out (ignored)',
                  }),
              }),
            ),
          )
        }
        accountCache = new Map()
        invalidateProbeCache()

        const manifest = trezorCfg?.email
          ? {
              email: trezorCfg.email,
              appUrl: trezorCfg.appUrl ?? defaultManifest.appUrl,
              appName: trezorCfg.appName ?? defaultManifest.appName,
            }
          : trezorCfg?.email === undefined && trezorCfg?.appUrl === undefined
            ? defaultManifest
            : {
                email: trezorCfg?.email ?? defaultManifest.email,
                appUrl: trezorCfg?.appUrl ?? defaultManifest.appUrl,
                appName: trezorCfg?.appName ?? defaultManifest.appName,
              }

        // Build service-level UI callbacks that update trezorUIRequest state
        // and return promises resolved by the UI via resolveTrezorPin/resolveTrezorPassphrase.
        const serviceOnPinRequest = (type?: 'current' | 'new_first' | 'new_second') =>
          new Promise<string>((resolve, reject) => {
            pinResolve = resolve
            pinReject = () => reject(new Error('PIN entry cancelled'))
            Effect.runSync(
              updateState((s) => ({
                ...s,
                trezorUIRequest: type ? {type: 'pin', pinType: type} : {type: 'pin'},
              })),
            )
            // Timeout: reject after 5 minutes if user hasn't responded
            const timer = setTimeout(() => {
              if (pinResolve === resolve) {
                pinResolve = null
                pinReject = null
                Effect.runSync(updateState((s) => ({...s, trezorUIRequest: null})))
                reject(new Error('PIN entry timed out'))
              }
            }, UI_TIMEOUT_MS)
            // Clear timeout when resolved/rejected
            const origResolve = resolve
            pinResolve = (pin: string) => {
              clearTimeout(timer)
              origResolve(pin)
            }
            const origReject = pinReject
            pinReject = () => {
              clearTimeout(timer)
              origReject?.()
            }
          })

        const serviceOnInvalidPin = () => {
          Effect.runSync(
            updateState((s) => ({
              ...s,
              trezorUIRequest: {type: 'invalid_pin'},
            })),
          )
        }

        const serviceOnPassphraseRequest = () =>
          new Promise<{value: string; passphraseOnDevice?: boolean}>((resolve, reject) => {
            passphraseResolve = resolve
            passphraseReject = () => reject(new Error('Passphrase entry cancelled'))
            Effect.runSync(
              updateState((s) => ({
                ...s,
                trezorUIRequest: {type: 'passphrase'},
              })),
            )
            const timer = setTimeout(() => {
              if (passphraseResolve === resolve) {
                passphraseResolve = null
                passphraseReject = null
                Effect.runSync(updateState((s) => ({...s, trezorUIRequest: null})))
                reject(new Error('Passphrase entry timed out'))
              }
            }, UI_TIMEOUT_MS)
            const origResolve = resolve
            passphraseResolve = (result: {value: string; passphraseOnDevice?: boolean}) => {
              clearTimeout(timer)
              origResolve(result)
            }
            const origReject = passphraseReject
            passphraseReject = () => {
              clearTimeout(timer)
              origReject?.()
            }
          })

        const serviceOnButtonRequest = (code: string) => {
          Effect.runSync(
            updateState((s) => ({
              ...s,
              trezorUIRequest: {type: 'button', code},
            })),
          )
        }

        const serviceOnPairingCode = (_prompt: string) =>
          new Promise<string>((resolve, reject) => {
            pairingCodeResolve = resolve
            pairingCodeReject = () => reject(new Error('Pairing code entry cancelled'))
            Effect.runSync(
              updateState((s) => ({
                ...s,
                trezorUIRequest: {type: 'pairing_code'},
              })),
            )
            const timer = setTimeout(() => {
              if (pairingCodeResolve === resolve) {
                pairingCodeResolve = null
                pairingCodeReject = null
                Effect.runSync(updateState((s) => ({...s, trezorUIRequest: null})))
                reject(new Error('Pairing code entry timed out'))
              }
            }, UI_TIMEOUT_MS)
            const origResolve = resolve
            pairingCodeResolve = (code: string) => {
              clearTimeout(timer)
              origResolve(code)
            }
            const origReject = pairingCodeReject
            pairingCodeReject = () => {
              clearTimeout(timer)
              origReject?.()
            }
          })

        const trezorConfig: TrezorConfig = {
          type: 'trezor',
          email: manifest.email,
          appUrl: manifest.appUrl,
          appName: manifest.appName,
          // 2 minutes per USB call — Cardano signing has many ButtonRequests
          // that require user confirmation on the device screen
          timeout: 120_000,
          ...trezorCfg,
          logger,
          // Always override callbacks with service-level ones
          onPinRequest: serviceOnPinRequest,
          onInvalidPin: serviceOnInvalidPin,
          onPassphraseRequest: serviceOnPassphraseRequest,
          onButtonRequest: serviceOnButtonRequest,
          onPairingCode: serviceOnPairingCode,
        }

        // Store for reconnection
        lastTrezorConfig = trezorCfg
        lastDeviceType = 'trezor'

        try {
          // Create platform-appropriate transport adapter directly (no @trezor/connect)
          const {adapter, devicePath} = yield* Effect.tryPromise({
            try: async () => {
              // Type alias for the transport adapter shape returned by createTransportAdapter
              type Adapter = {
                init: (params?: {signal?: AbortSignal}) => Promise<unknown>
                enumerate: (params?: {signal?: AbortSignal}) => Promise<unknown>
                acquire: (params: {input: {path: string; previous: string | null}; signal?: AbortSignal}) => Promise<{
                  success: boolean
                  payload?: string
                  error?: string
                }>
                release: (params: {path: string; session: string; signal?: AbortSignal}) => Promise<unknown>
                call: (params: {
                  session: string
                  name: string
                  data: Record<string, unknown>
                  signal?: AbortSignal
                  timeout?: number
                  protocol?: 'v1' | 'v2'
                  thpState?: unknown
                }) => Promise<unknown>
                updateMessages: (msgs: unknown) => void
                loadMessages: (packageName: string, packageLoader: () => unknown) => Promise<void>
              }

              // Detect platform without importing react-native:
              // - Web/extension: has document global
              // - React Native: no document, has navigator but no document
              const isWeb = typeof document !== 'undefined'

              let transport: Adapter

              const wantBridge = (trezorCfg?.transports as string[] | undefined)?.includes('BridgeTransport')

              if (wantBridge) {
                const {createBridgeTransport} = await import('../trezor-protocol/bridge-transport')
                const bridgeUrl = trezorCfg?.bridgeUrl ?? 'http://127.0.0.1:21328'
                logger.debug('Bridge transport: connecting to Trezor HTTP bridge', {
                  origin: 'HardwareWalletService',
                  bridgeUrl,
                })
                const bridgeTransport = createBridgeTransport({
                  url: bridgeUrl,
                })

                logger.debug('Bridge transport: enumerating devices...', {
                  origin: 'HardwareWalletService',
                })
                const enumResult = await bridgeTransport.enumerate()
                const descriptors = Array.isArray(enumResult) ? enumResult : []
                logger.debug('Bridge transport: enumeration complete', {
                  origin: 'HardwareWalletService',
                  deviceCount: descriptors.length,
                  devices: descriptors.map((d) => ({
                    path: d.path,
                    product: d.product,
                  })),
                })
                const first = descriptors[0]
                if (!first) {
                  throw new DeviceNotConnectedError({
                    deviceType: 'trezor',
                    message:
                      'No Trezor emulator found via bridge. Ensure trezor-user-env is running and bridge-start was sent.',
                  })
                }
                logger.debug('Bridge transport: using emulator device', {
                  origin: 'HardwareWalletService',
                  path: first.path,
                })
                return {
                  adapter: bridgeTransport as unknown as import('../trezor-protocol/device-session').TransportAdapter,
                  devicePath: first.path,
                }
              }

              if (isWeb) {
                // Web/extension: use WebUSB or Web Bluetooth transport
                const requested = trezorCfg?.transports as string[] | undefined
                const wantWebUsb = !requested || requested.includes('WebUsbTransport')
                const wantWebBle = requested?.includes('WebBluetoothTransport')

                if (wantWebBle) {
                  const bleDeviceApi = trezorCfg?.bleDeviceApi as unknown

                  const transportLogger = {
                    debug: (...args: unknown[]) =>
                      logger.debug(args.map(String).join(' '), {
                        origin: 'TrezorBLE',
                      }),
                    log: (...args: unknown[]) =>
                      logger.info(args.map(String).join(' '), {
                        origin: 'TrezorBLE',
                      }),
                    warn: (...args: unknown[]) =>
                      logger.warn(args.map(String).join(' '), {
                        origin: 'TrezorBLE',
                      }),
                    error: (...args: unknown[]) =>
                      logger.error(args.map(String).join(' '), {
                        origin: 'TrezorBLE',
                      }),
                  }

                  if (bleDeviceApi) {
                    // Extension sidepanel: use bridge device API relayed through extension messaging
                    logger.debug('Web BLE: using bridge device API', {
                      origin: 'HardwareWalletService',
                    })
                    const trezorNativeAdapter = '@pnyx/hardware/trezor-native/transport/adapter' as string
                    const {createTransportAdapter} = (await import(trezorNativeAdapter)) as {
                      createTransportAdapter: (opts: {name: string; api: unknown; logger?: unknown}) => Adapter
                    }
                    transport = createTransportAdapter({
                      name: 'WebBluetoothBridgeTransport',
                      api: bleDeviceApi,
                      logger: transportLogger,
                    })
                  } else if (typeof navigator !== 'undefined' && 'bluetooth' in navigator) {
                    // Fullscreen tab: use direct Web Bluetooth
                    const trezorWebBle = '@pnyx/hardware/trezor-web-ble' as string
                    const {createWebBluetoothTransport, webBluetoothManager} = (await import(trezorWebBle)) as {
                      createWebBluetoothTransport: (opts: Record<string, unknown>) => Adapter
                      webBluetoothManager: {
                        connectDevice: (opts?: {
                          timeoutMs?: number
                          log?: (...args: unknown[]) => void
                        }) => Promise<unknown>
                        onDeviceConnectionStatusChange: (cb: (event: {connectionStatus: {type: string}}) => void) => {
                          remove: () => void
                        }
                      }
                    }

                    logger.debug('Web BLE: requesting device via browser picker...', {origin: 'HardwareWalletService'})
                    const bleLog = (...args: unknown[]) =>
                      logger.debug(args.map(String).join(' '), {
                        origin: 'TrezorBLE',
                      })
                    await webBluetoothManager.connectDevice({
                      timeoutMs: 60_000,
                      log: bleLog,
                    })
                    logger.debug('Web BLE: device connected', {
                      origin: 'HardwareWalletService',
                    })

                    transport = createWebBluetoothTransport({
                      logger: transportLogger,
                    })

                    if (bleDisconnectCleanup) bleDisconnectCleanup()
                    const sub = webBluetoothManager.onDeviceConnectionStatusChange((event) => {
                      if (event.connectionStatus.type === 'disconnected') {
                        logger.info('Trezor BLE device disconnected', {
                          origin: 'HardwareWalletService',
                        })
                        Effect.runPromise(disconnect()).catch((e) => {
                          logger.warn('Disconnect after a Trezor BLE drop failed', {
                            origin: 'HardwareWalletService',
                            error: String(e),
                          })
                        })
                      }
                    })
                    bleDisconnectCleanup = () => sub.remove()
                  } else {
                    throw new Error('Web Bluetooth not available and no bridge device API provided')
                  }
                } else if (wantWebUsb && typeof navigator !== 'undefined' && 'usb' in navigator) {
                  // WebUSB path: create USB device API + transport adapter
                  const trezorNativeUsb = '@pnyx/hardware/trezor-native/usb/usb-device-api' as string
                  const trezorNativeAdapter = '@pnyx/hardware/trezor-native/transport/adapter' as string
                  const {createUsbDeviceApi} = (await import(trezorNativeUsb)) as {
                    createUsbDeviceApi: (opts: {usbInterface: unknown; logger?: unknown}) => unknown
                  }
                  const {createTransportAdapter} = (await import(trezorNativeAdapter)) as {
                    createTransportAdapter: (opts: {name: string; api: unknown; logger?: unknown}) => Adapter
                  }

                  const transportLogger = {
                    debug: (...args: unknown[]) =>
                      logger.debug(args.map(String).join(' '), {
                        origin: 'TrezorUSB',
                      }),
                    log: (...args: unknown[]) =>
                      logger.info(args.map(String).join(' '), {
                        origin: 'TrezorUSB',
                      }),
                    warn: (...args: unknown[]) =>
                      logger.warn(args.map(String).join(' '), {
                        origin: 'TrezorUSB',
                      }),
                    error: (...args: unknown[]) =>
                      logger.error(args.map(String).join(' '), {
                        origin: 'TrezorUSB',
                      }),
                  }

                  const api = createUsbDeviceApi({
                    usbInterface: navigator.usb,
                    logger: transportLogger,
                  })
                  transport = createTransportAdapter({
                    name: 'WebUsbTransport',
                    api,
                    logger: transportLogger,
                  })
                } else {
                  throw new Error('No supported Trezor transport available (WebUSB or Web Bluetooth required)')
                }
              } else {
                // Mobile (React Native): use native USB or Bluetooth transport
                const trezorNative = '@pnyx/hardware/trezor-native' as string
                const {
                  createNativeUsbTransport,
                  createNativeBluetoothTransport,
                  bluetoothManager: nativeBleManager,
                } = (await import(trezorNative)) as {
                  createNativeUsbTransport: (opts: Record<string, unknown>) => Adapter | Promise<Adapter>
                  createNativeBluetoothTransport: (opts: Record<string, unknown>) => Adapter
                  bluetoothManager: {
                    setBleManager: (manager: unknown) => boolean
                    waitForPoweredOn: (timeoutMs?: number) => Promise<void>
                    startDeviceScan: (errorHandler?: (e: unknown) => void) => void
                    stopDeviceScan: () => void
                    connectDevice: (opts: {deviceId: string; timeoutMs?: number}) => Promise<unknown>
                    onNearbyDevicesChange: (cb: (devices: Array<{id: string; name: string}>) => void) => {
                      remove: () => void
                    }
                    onDeviceConnectionStatusChange: (
                      cb: (event: {deviceId: string; connectionStatus: {type: string}}) => void,
                    ) => {remove: () => void}
                    getConnectedDeviceIds: () => string[]
                  }
                }

                // Share the app's single BleManager with the native Trezor
                // transport so it connects on the SAME client that scanned (two
                // clients contend for the adapter). No-op if already adopted.
                const sharedBleManager = config.platformGetBleManager?.()
                const adopted = sharedBleManager ? nativeBleManager.setBleManager(sharedBleManager) : false
                logger.debug('BLE: shared manager injection', {
                  origin: 'HardwareWalletService',
                  hasShared: sharedBleManager !== undefined && sharedBleManager !== null,
                  adopted,
                })

                // Caller can filter transports via string names (e.g. ['NativeUsbTransport'])
                const requested = trezorCfg?.transports as string[] | undefined
                const wantUsb = !requested || requested.includes('NativeUsbTransport')
                const wantBle = !requested || requested.includes('NativeBluetoothTransport')

                // Render console-style args without losing object content:
                // `String({})` returns `'[object Object]'`, which makes logs like
                // `onDeviceConnectionStatusChange [object Object]` useless.
                //
                // `Error` instances need special handling: their `message`,
                // `name`, `stack` are non-enumerable, so `JSON.stringify(err)`
                // returns `'{}'`. Downstream callers in the Trezor native
                // transport (e.g. `usb-device-api.ts: logger?.error('usb:
                // unexpected error:', err)`) pass raw `Error` objects — losing
                // their messages would silently hide hardware-failure causes.
                // Render Errors as `String(err)` (e.g. `'Error: …'`) which
                // preserves the message via the prototype `toString`.
                const formatArg = (arg: unknown): string => {
                  if (arg === null || arg === undefined) return String(arg)
                  if (arg instanceof Error) return String(arg)
                  if (typeof arg !== 'object') return String(arg)
                  try {
                    return JSON.stringify(arg)
                  } catch (e: unknown) {
                    // A cyclic or unserialisable argument inside a log formatter. Falling back to
                    // the tag is right; throwing from a logger would take the caller down.
                    logger.debug('Log argument could not be serialised', {
                      origin: 'hardware-wallet-service',
                      error: String(e),
                    })
                    return Object.prototype.toString.call(arg)
                  }
                }
                const fmt = (args: unknown[]): string => args.map(formatArg).join(' ')

                // Per-APDU + per-BLE-status traces from the Trezor native transport
                // emit hundreds of lines per session. Useful when debugging the
                // protocol layer, ruinous for everyday log audit. Gate `.debug`
                // behind an opt-in env flag; warn/error/info always flow.
                const trezorTraceEnabled = process.env.EXPO_PUBLIC_TREZOR_TRACE === 'true'
                const debugFn = trezorTraceEnabled
                  ? (...args: unknown[]) =>
                      logger.debug(fmt(args), {
                        origin: 'TrezorNativeTransport',
                      })
                  : () => {}
                const nativeTransportLogger = {
                  debug: debugFn,
                  log: (...args: unknown[]) => logger.info(fmt(args), {origin: 'TrezorNativeTransport'}),
                  warn: (...args: unknown[]) => logger.warn(fmt(args), {origin: 'TrezorNativeTransport'}),
                  error: (...args: unknown[]) =>
                    logger.error(fmt(args), {
                      origin: 'TrezorNativeTransport',
                    }),
                }

                // Detect Android vs iOS via react-native Platform (lazy import, only in RN context)
                let platformOS = 'unknown'
                try {
                  const rn = 'react-native' as string
                  const mod = (await import(rn)) as {
                    Platform?: {OS?: string}
                  }
                  platformOS = mod.Platform?.OS ?? 'unknown'
                } catch (e: unknown) {
                  // ⚠️ This GUESSES android when the platform cannot be read, which decides the
                  // transport order (USB before BLE). Wrong on iOS, and silently so.
                  logger.warn('Platform could not be detected; assuming android for transport order', {
                    origin: 'hardware-wallet-service',
                    error: String(e),
                  })
                  platformOS = 'android'
                }

                let isBleTransport = false

                if (platformOS === 'android' && wantUsb) {
                  transport = await createNativeUsbTransport({
                    logger: nativeTransportLogger,
                  })
                } else if (wantBle) {
                  transport = createNativeBluetoothTransport({
                    logger: nativeTransportLogger,
                  })
                  isBleTransport = true
                } else if (wantUsb) {
                  transport = await createNativeUsbTransport({
                    logger: nativeTransportLogger,
                  })
                } else {
                  throw new Error('No supported Trezor transport available on this platform')
                }

                // BLE requires scanning + connecting before enumerate can find devices
                if (isBleTransport) {
                  // Skip if a Trezor is already connected (e.g. reconnection)
                  if (nativeBleManager.getConnectedDeviceIds().length === 0) {
                    // Request BLE permissions (Android needs runtime permissions)
                    if (config.platformRequestBLEPermissions) {
                      const granted = await config.platformRequestBLEPermissions()
                      if (!granted) {
                        throw new Error('Bluetooth permissions are required. Please enable them in Settings.')
                      }
                    }

                    // Wait for the BLE adapter to be ready before scanning.
                    logger.debug('BLE: waiting for adapter to be ready...', {
                      origin: 'HardwareWalletService',
                    })
                    await nativeBleManager.waitForPoweredOn(10_000)

                    // Scan for a nearby Trezor, resolving when a matching device
                    // appears (a specific `targetId`, else the first Trezor seen).
                    // Discovery is mandatory before connect-by-id can reach a
                    // peripheral that THIS BLE manager hasn't seen — the app-level
                    // scan that populated the pair screen runs on a *different*
                    // BleManager instance, so its peripherals are unknown here.
                    const scanForBleDevice = (targetId?: string) =>
                      new Promise<{id: string; name: string}>((resolve, reject) => {
                        const scanTimeout = setTimeout(() => {
                          nativeBleManager.stopDeviceScan()
                          nearbyDeviceSub.remove()
                          reject(
                            new Error(
                              'Trezor BLE scan timed out. Make sure your Trezor is nearby with Bluetooth enabled.',
                            ),
                          )
                        }, 30_000)

                        const nearbyDeviceSub = nativeBleManager.onNearbyDevicesChange((devices) => {
                          const device = targetId ? devices.find((d) => d.id === targetId) : devices[0]
                          if (device) {
                            clearTimeout(scanTimeout)
                            nativeBleManager.stopDeviceScan()
                            nearbyDeviceSub.remove()
                            resolve(device)
                          }
                        })

                        nativeBleManager.startDeviceScan((scanError) => {
                          clearTimeout(scanTimeout)
                          nearbyDeviceSub.remove()
                          reject(
                            new Error(
                              `BLE scan failed: ${scanError instanceof Error ? scanError.message : String(scanError)}`,
                            ),
                          )
                        })
                      })

                    const storedBleDeviceId = trezorCfg?.bleDeviceId
                    if (storedBleDeviceId) {
                      // Fast path: the peripheral may already be known to this
                      // manager (an in-session reconnect, or still OS-bonded) —
                      // try a direct connect first.
                      try {
                        logger.debug('BLE: connecting to stored device...', {
                          origin: 'HardwareWalletService',
                          deviceId: storedBleDeviceId,
                        })
                        await nativeBleManager.connectDevice({
                          deviceId: storedBleDeviceId,
                          timeoutMs: 15_000,
                        })
                        logger.debug('BLE: device connected', {
                          origin: 'HardwareWalletService',
                        })
                        lastBleDeviceId = storedBleDeviceId
                      } catch (directErr) {
                        // Connect-by-id can't reach an undiscovered peripheral
                        // (e.g. the OS bond was forgotten, or it was discovered by
                        // another manager). Rescan for the exact device, then connect.
                        logger.warn('BLE: direct connect failed, rescanning for device', {
                          origin: 'HardwareWalletService',
                          deviceId: storedBleDeviceId,
                          error: String(directErr),
                        })
                        const found = await scanForBleDevice(storedBleDeviceId)
                        await nativeBleManager.connectDevice({
                          deviceId: found.id,
                          timeoutMs: 15_000,
                        })
                        logger.debug('BLE: device connected after rescan', {
                          origin: 'HardwareWalletService',
                        })
                        lastBleDeviceId = found.id
                      }
                    } else {
                      // No target id — scan and take the first Trezor found.
                      logger.debug('BLE: scanning for Trezor devices...', {
                        origin: 'HardwareWalletService',
                      })
                      const found = await scanForBleDevice()
                      logger.debug('BLE: found device, connecting...', {
                        origin: 'HardwareWalletService',
                        deviceId: found.id,
                        deviceName: found.name,
                      })
                      await nativeBleManager.connectDevice({
                        deviceId: found.id,
                        timeoutMs: 15_000,
                      })
                      logger.debug('BLE: device connected', {
                        origin: 'HardwareWalletService',
                      })
                      lastBleDeviceId = found.id
                    }
                  }

                  // Monitor for BLE disconnects
                  if (bleDisconnectCleanup) bleDisconnectCleanup()
                  const bleSub = nativeBleManager.onDeviceConnectionStatusChange((event) => {
                    if (event.connectionStatus.type === 'disconnected') {
                      logger.info('Trezor BLE device disconnected', {
                        origin: 'HardwareWalletService',
                      })
                      Effect.runPromise(disconnect()).catch((e) => {
                        logger.warn('Disconnect after a Trezor BLE drop failed', {
                          origin: 'HardwareWalletService',
                          error: String(e),
                        })
                      })
                    }
                  })
                  bleDisconnectCleanup = () => bleSub.remove()
                }
              }

              // Initialize transport and enumerate devices
              logger.debug('Transport: init...', {
                origin: 'HardwareWalletService',
              })
              await transport.init()
              logger.debug('Transport: init done, enumerating...', {
                origin: 'HardwareWalletService',
              })
              const enumerateResult = (await transport.enumerate()) as
                | {success: true; payload: Array<{path: string}>}
                | Array<{path: string}>
              const descriptors = Array.isArray(enumerateResult)
                ? enumerateResult
                : (enumerateResult as {payload: Array<{path: string}>}).payload
              logger.debug('Transport: enumerate done', {
                origin: 'HardwareWalletService',
                deviceCount: descriptors?.length ?? 0,
              })

              const first = descriptors?.[0]
              if (!first) {
                throw new DeviceNotConnectedError({
                  deviceType: 'trezor',
                  message: 'No Trezor devices found. Make sure your device is connected and unlocked.',
                })
              }

              // Use first discovered device
              const path = first.path
              logger.debug('Transport: using device', {
                origin: 'HardwareWalletService',
                path,
              })

              return {
                adapter: transport as unknown as import('../trezor-protocol/device-session').TransportAdapter,
                devicePath: path,
              }
            },
            catch: (error) =>
              new HardwareError({
                message: `Failed to create Trezor transport: ${error instanceof Error ? error.message : String(error)}`,
                cause: error,
              }),
          })

          logger.debug('Transport: creating device...', {
            origin: 'HardwareWalletService',
          })
          const device = createTrezorDevice(adapter, devicePath, trezorConfig)
          currentDevice = device

          logger.debug('Transport: device.connect()...', {
            origin: 'HardwareWalletService',
          })
          yield* device.connect()

          // Refresh callbacks after connect to ensure the UI_EVENT handler
          // always reads the service's current refs, not stale connection-time closures
          device.updateCallbacks?.({
            onPinRequest: serviceOnPinRequest,
            onInvalidPin: serviceOnInvalidPin,
            onPassphraseRequest: serviceOnPassphraseRequest,
            onButtonRequest: serviceOnButtonRequest,
            onPairingCode: serviceOnPairingCode,
          })

          const info = yield* device.getInfo()

          const connectedDevice: ConnectedDevice = {
            type: 'trezor',
            model: info.model,
            firmwareVersion: info.firmwareVersion,
            deviceId: info.deviceId,
            ...(info.label !== undefined ? {label: info.label} : {}),
            device,
          }

          yield* updateState((s) => ({
            ...s,
            isConnecting: false,
            connectedDevice,
          }))

          logger.info('Trezor connected', {
            origin: 'HardwareWalletService',
            model: info.model,
            firmware: info.firmwareVersion,
          })

          return connectedDevice
        } catch (error) {
          const hwError =
            error instanceof HardwareError
              ? error
              : new HardwareError({
                  message: `Trezor connection failed: ${error instanceof Error ? error.message : String(error)}`,
                  cause: error,
                })
          logger.error('Trezor connect failed', {
            origin: 'HardwareWalletService',
            error: String(error),
          })
          yield* updateState((s) => ({
            ...s,
            isConnecting: false,
            lastError: hwError,
          }))
          return yield* Effect.fail(hwError)
        }
      })

    const disconnect = (opts?: {intentional?: boolean}): Effect.Effect<void, HardwareErrorType> =>
      Effect.gen(function* () {
        if (opts?.intentional) intentionalDisconnect = true
        if (bleDisconnectCleanup) {
          bleDisconnectCleanup()
          bleDisconnectCleanup = null
        }

        // Reject any pending Trezor UI prompts (PIN / passphrase / pairing
        // code) before tearing down the transport. Each prompt arms a 5-min
        // `setTimeout` that would otherwise fire after navigation and
        // resolve the awaiting SDK call long after the user has left the
        // signing screen — surfacing as a stale "Signing transaction…"
        // overlay on a different screen.
        if (pinReject) {
          pinReject()
          pinResolve = null
          pinReject = null
        }
        if (passphraseReject) {
          passphraseReject()
          passphraseResolve = null
          passphraseReject = null
        }
        if (pairingCodeReject) {
          pairingCodeReject()
          pairingCodeResolve = null
          pairingCodeReject = null
        }
        yield* Effect.either(updateState((s) => ({...s, trezorUIRequest: null})))

        // State-first teardown: drop references and reset confirmation state
        // BEFORE awaiting native close. On iOS BLE, `transport.close()` can
        // hang indefinitely when the GATT is half-open — if we awaited first
        // (as the previous flow did) `currentDevice` would never get cleared,
        // and the next attempt would reuse a dead device, manifesting as a
        // permanent "connecting to device" hang.
        const deviceToClose = currentDevice
        const bleDeviceIdToClose = lastDeviceType === 'ledger' ? lastBleDeviceId : null
        const factoryForForcedDisconnect = lastTransportFactory
        currentDevice = null
        accountCache = new Map()
        invalidateProbeCache()
        confirmationManager.reset()

        yield* updateState((s) => ({
          ...s,
          connectedDevice: null,
          currentApp: null,
        }))

        if (deviceToClose) {
          // Bounded best-effort close. The 2s cap ensures cleanup completes
          // even when the native transport.close() Promise never settles.
          yield* Effect.either(
            deviceToClose.disconnect().pipe(
              Effect.timeoutFail({
                duration: Duration.seconds(2),
                onTimeout: () =>
                  new HardwareError({
                    message: 'transport.close() timed out (ignored)',
                  }),
              }),
            ),
          )
        }

        // `transport.close()` only frees JS handles; the OS GATT slot
        // can stay held after a half-open notify failure and block the
        // next `TransportBLE.open()`. `BleTransport.disconnectDevice(id)`
        // is not bounded internally — the 2s cap matches the soft close
        // above.
        if (bleDeviceIdToClose && factoryForForcedDisconnect?.forceBleDisconnect) {
          const forceFn = factoryForForcedDisconnect.forceBleDisconnect
          const forceStartedAt = Date.now()
          const forceResult = yield* Effect.either(
            Effect.tryPromise({
              try: () => forceFn(bleDeviceIdToClose),
              catch: (e) =>
                new HardwareError({
                  message: `forceBleDisconnect failed: ${e instanceof Error ? e.message : String(e)}`,
                  cause: e,
                }),
            }).pipe(
              Effect.timeoutFail({
                duration: Duration.seconds(2),
                onTimeout: () =>
                  new HardwareError({
                    message: 'forceBleDisconnect timed out (ignored)',
                  }),
              }),
            ),
          )
          if (forceResult._tag === 'Left') {
            logger.warn('forceBleDisconnect failed (ignored)', {
              origin: 'HardwareWalletService',
              bleDeviceId: bleDeviceIdToClose,
              elapsedMs: Date.now() - forceStartedAt,
              errorMessage: forceResult.left.message,
            })
          }
        }

        logger.info('Device disconnected', {origin: 'HardwareWalletService'})
      })

    const isConnected = (): boolean => currentDevice?.isConnected() ?? false

    const isSwitchingApp = (): boolean => appSwitchGuard.isActive()

    /**
     * Send the BOLOS quit-app APDU on the connected Ledger. Bounded at 2s
     * because on BLE the GATT drops as a side effect of quit-app and the
     * APDU response may never arrive. No-op when no Ledger is connected.
     */
    const quitApp = (): Effect.Effect<void, HardwareErrorType> =>
      Effect.gen(function* () {
        if (!currentDevice?.quitApp) return
        yield* Effect.either(
          currentDevice.quitApp().pipe(
            Effect.timeoutFail({
              duration: Duration.seconds(2),
              onTimeout: () => new HardwareError({message: 'quitApp timed out (ignored)'}),
            }),
          ),
        )
        invalidateProbeCache()
      })

    /**
     * Core account derivation logic.
     * Extracted so getAccounts can retry once on transport failures (BLE silent disconnect).
     */
    const getAccountsCore = (
      chain: ChainId,
      count: number,
      startIndex: number,
    ): Effect.Effect<readonly HardwareAccount[], HardwareErrorType> =>
      Effect.gen(function* () {
        yield* ensureReady(chain)

        if (!currentDevice) {
          logger.error('getAccounts failed: No device connected', {
            origin: 'HardwareWalletService',
          })
          return yield* Effect.fail(new HardwareError({message: 'No device connected'}))
        }

        const accounts: HardwareAccount[] = []

        // Tron/Solana: address-level paths — device returns the address directly.
        // Other chains: account-level paths — caller derives addresses from xpub.
        // Ledger Solana uses m/44'/501'/account' (3 levels); Trezor/others use m/44'/501'/account'/0' (4 levels).
        const usesAddressLevelPaths = chain === TRON_MAINNET || chain === SOLANA_MAINNET
        const paths = usesAddressLevelPaths
          ? Array.from({length: count}, (_, i) =>
              chain === SOLANA_MAINNET && lastDeviceType === 'ledger'
                ? solanaLedgerPath(startIndex + i)
                : getAddressPath(chain, startIndex + i, 0),
            )
          : Array.from({length: count}, (_, i) => getAccountPath(chain, startIndex + i))
        logger.debug('Getting extended public keys', {
          origin: 'HardwareWalletService',
          paths,
          count,
        })

        const xpubs = yield* currentDevice.getExtendedPublicKeys(paths)

        logger.debug('Got extended public keys', {
          origin: 'HardwareWalletService',
          count: xpubs.length,
        })

        for (let j = 0; j < paths.length; j++) {
          const path = paths[j] as (typeof paths)[number]
          const xpub = xpubs[j] as (typeof xpubs)[number]
          accounts.push({
            index: startIndex + j,
            path,
            address: xpub.address ?? '',
            publicKey: xpub.publicKey,
            chainCode: xpub.chainCode,
          })
        }

        // Cache accounts for later public key derivation during signing
        for (const account of accounts) {
          accountCache.set(getAccountCacheKey(chain, account.index), account)
        }

        logger.info('Successfully retrieved accounts', {
          origin: 'HardwareWalletService',
          chain,
          accountCount: accounts.length,
        })
        return accounts
      })

    const getAccounts = (
      chain: ChainId,
      count = 5,
      startIndex = 0,
    ): Effect.Effect<readonly HardwareAccount[], HardwareErrorType> =>
      Effect.gen(function* () {
        logger.debug('getAccounts called', {
          origin: 'HardwareWalletService',
          chain,
          count,
          startIndex,
          hasDevice: currentDevice !== null,
          isConnected: currentDevice?.isConnected() ?? false,
        })

        const result = yield* Effect.either(getAccountsCore(chain, count, startIndex))
        if (result._tag === 'Right') return result.right

        const error = result.left
        // BLE can silently disconnect during screen transitions on mobile.
        // isConnected() may return a stale true, so the first APDU call fails.
        // Reset stale connection state and retry once — ensureConnected inside
        // getAccountsCore will re-establish the BLE connection on the second attempt.
        if (error._tag === 'DeviceNotConnectedError' || error._tag === 'TransportError') {
          logger.warn('Transport error during getAccounts, resetting stale connection state and retrying', {
            origin: 'HardwareWalletService',
            chain,
            errorTag: error._tag,
          })

          if (currentDevice) {
            yield* Effect.either(currentDevice.disconnect())
            currentDevice = null
          }
          invalidateProbeCache()

          // Retry once after reset — ensureConnected will reconnect via stored BLE device ID
          return yield* getAccountsCore(chain, count, startIndex)
        }

        // Wrong app: reset cached app state and retry once. Stale sessions need a
        // full close/open cycle so the device app can clear its internal state.
        const recoveryStrategy = resolveLedgerAppRecoveryStrategy(error)
        if (recoveryStrategy === 'retry') {
          logger.warn('App error during getAccounts, resetting cached app state and retrying', {
            origin: 'HardwareWalletService',
            chain,
            errorTag: error._tag,
          })
          yield* updateState((s) => ({...s, currentApp: null}))
          return yield* getAccountsCore(chain, count, startIndex)
        }

        if (recoveryStrategy === 'force-reopen') {
          yield* recoverLedgerStaleSession(chain, error)
          return yield* getAccountsCore(chain, count, startIndex)
        }

        return yield* Effect.fail(error)
      })

    const getAccount = (chain: ChainId, index: number): Effect.Effect<HardwareAccount, HardwareErrorType> =>
      Effect.gen(function* () {
        const accounts = yield* getAccounts(chain, 1, index)
        const account = accounts[0]
        if (!account) {
          return yield* Effect.fail(
            new HardwareError({
              message: `Failed to get account at index ${index}`,
            }),
          )
        }
        return account
      })

    const verifyAddress = (
      address: string,
      derivationPath: string,
      _chain: ChainId,
    ): Effect.Effect<boolean, HardwareErrorType> =>
      Effect.gen(function* () {
        if (!currentDevice) {
          return yield* Effect.fail(new HardwareError({message: 'No device connected'}))
        }

        yield* updateState((s) => ({
          ...s,
          confirmationState: {
            type: 'confirm-on-device',
            message: 'Please verify on your device',
          },
        }))

        const result = yield* currentDevice.verifyAddress(address, derivationPath).pipe(
          Effect.catchAll((error) =>
            Effect.gen(function* () {
              const hwError =
                error instanceof HardwareError
                  ? error
                  : new HardwareError({
                      message: String(error),
                      cause: error,
                    })
              yield* updateState((s) => ({
                ...s,
                confirmationState: {type: 'error', error: hwError},
                lastError: hwError,
              }))
              return yield* Effect.fail(hwError)
            }),
          ),
        )
        yield* updateState((s) => ({
          ...s,
          confirmationState: result ? {type: 'completed'} : {type: 'rejected'},
        }))
        return result
      })

    const getDeviceInfo = (): Effect.Effect<import('../types').DeviceInfo, HardwareErrorType> =>
      Effect.gen(function* () {
        if (!currentDevice) {
          return yield* Effect.fail(new HardwareError({message: 'No device connected'}))
        }
        return yield* currentDevice.getInfo()
      })

    const getDeviceFeatures = (): Effect.Effect<import('../types').DeviceFeatures, HardwareErrorType> =>
      Effect.gen(function* () {
        if (!currentDevice) {
          return yield* Effect.fail(new HardwareError({message: 'No device connected'}))
        }
        return yield* currentDevice.getFeatures()
      })

    const getAppVersion = (): Effect.Effect<import('../types').AppVersion, HardwareErrorType> =>
      Effect.gen(function* () {
        if (!currentDevice) {
          return yield* Effect.fail(new HardwareError({message: 'No device connected'}))
        }
        return yield* currentDevice.getAppVersion()
      })

    const openApp = (
      appName: string,
      options?: {readonly allowReconnectOnOpenAppError?: boolean},
    ): Effect.Effect<void, HardwareErrorType> =>
      Effect.gen(function* () {
        if (!currentDevice) {
          // A prior failed switch (or a real unplug the user has since
          // reconnected) can leave us with no device. Try to reconnect before
          // giving up so a user-driven "Try again" can recover instead of
          // dead-ending on "No device connected".
          yield* Effect.either(ensureConnected())
        }
        if (!currentDevice) {
          return yield* Effect.fail(new HardwareError({message: 'No device connected'}))
        }
        if (!currentDevice.openApp) {
          return yield* Effect.fail(
            new HardwareError({
              message: 'Device does not support programmatic app switching',
            }),
          )
        }

        const openAppResult = yield* Effect.either(currentDevice.openApp(appName))
        if (openAppResult._tag === 'Left') {
          const openAppError = openAppResult.left

          // BLE tears down the GATT while the device reboots into the new app
          // (e.g. Cardano → Ethereum during import). The device-level switch
          // already reconnects once, but on slower radios that single attempt
          // can lose the race and surface as DeviceNotConnectedError. Mirror the
          // signing path's ensureApp recovery: disconnect, reconnect, retry once.
          const shouldReconnect =
            (options?.allowReconnectOnOpenAppError ?? true) && shouldReconnectAfterOpenAppError(openAppError)

          if (shouldReconnect) {
            logger.warn('Ledger openApp failed; reconnecting and retrying once', {
              origin: 'HardwareWalletService',
              appName,
              errorTag: openAppError._tag,
              errorMessage: openAppError.message,
            })
            yield* Effect.either(disconnect())
            yield* ensureConnected()
            return yield* openApp(appName, {
              allowReconnectOnOpenAppError: false,
            })
          }

          return yield* Effect.fail(openAppError)
        }

        yield* updateState((s) => ({...s, currentApp: appName}))

        logger.info('Ledger app opened', {
          origin: 'HardwareWalletService',
          appName,
        })
      }).pipe(withAppSwitchGuard)

    // ========================================================================
    // ensureReady: auto-connect, app management, account caching
    // ========================================================================

    /**
     * Round-trips a small message to the device (Trezor `Ping`, Ledger BOLOS
     * `getAppAndVersion`) before trusting the cached `isConnected()` flag.
     *
     * Trezor's bridge daemon caches `GetFeatures` and keeps reporting "alive"
     * after physical disconnect; Ledger's USB/HID transport reports
     * "connected" while the chip is asleep / app crashed / BLE bridge has a
     * stale session. Both fail the round-trip — we then release the stale
     * transport so the next `ensureConnected` triggers a fresh reconnect
     * instead of dispatching APDUs into a dead session.
     *
     * Falls back to the cached `isConnected()` flag for transport adapters
     * that don't implement `pingDevice` (kept optional on the interface so
     * unrelated implementations don't break).
     */
    const hasHealthyConnection = (): Effect.Effect<boolean, never> =>
      Effect.gen(function* () {
        if (!currentDevice?.isConnected()) return false
        if (!currentDevice.pingDevice) return true

        // Probe debounce: a BOLOS probe (ping or getRunningAppName) that
        // succeeded < PROBE_CACHE_TTL_MS ago is fresh enough — the device
        // can not have silently dropped without our transport disconnect
        // handler firing and clearing the cache.
        if (lastProbeAtMs > 0 && Date.now() - lastProbeAtMs < PROBE_CACHE_TTL_MS) {
          return true
        }

        const probeResult = yield* Effect.either(
          currentDevice.pingDevice().pipe(
            Effect.timeoutFail({
              duration: Duration.seconds(2),
              onTimeout: () => new HardwareError({message: 'Health probe timed out'}),
            }),
          ),
        )
        if (probeResult._tag === 'Right') {
          lastProbeAtMs = Date.now()
          return true
        }

        const error = probeResult.left
        if (error._tag === 'DeviceLockedError') {
          if (shouldResetTransportOnLockedDevice(lastTransportHint)) {
            logger.warn('Health probe hit locked device on USB; resetting transport', {
              origin: 'HardwareWalletService',
            })
            const result = yield* Effect.either(disconnect())
            if (result._tag === 'Left') {
              logger.warn('disconnect failed during USB locked-device reset (transport may stay stale)', {
                origin: 'HardwareWalletService',
                error: result.left.message,
              })
            }
            return false
          }
          logger.debug('Health probe hit locked device on BLE; keeping connection', {origin: 'HardwareWalletService'})
          return true
        }

        logger.warn('Health probe failed; resetting stale connection before reconnect', {
          origin: 'HardwareWalletService',
          deviceType: lastDeviceType,
          errorTag: error._tag,
          errorMessage: error.message,
        })
        yield* Effect.either(disconnect())
        return false
      })

    const ensureConnected = (): Effect.Effect<void, HardwareErrorType> =>
      Effect.gen(function* () {
        // After a user-initiated disconnect the stored BLE peripheral handle is
        // dead — a direct reconnect to it times out through the whole cascade
        // (~40s) before failing. Fail fast so the UI shows the reconnect screen
        // at once; a fresh user-initiated connect clears the flag. Checked before
        // the health probe: disconnect() sets the flag, then yields once before
        // clearing currentDevice, so a concurrent caller can still see a stale
        // "healthy" device — the intent (don't reuse this device) wins regardless.
        if (intentionalDisconnect) {
          return yield* Effect.fail(
            new DeviceNotConnectedError({
              deviceType: lastDeviceType ?? 'ledger',
              message: 'Hardware wallet disconnected. Please reconnect your device.',
            }),
          )
        }

        // Mismatched-type connection means the user has switched between a
        // Ledger-imported wallet and a Trezor-imported wallet (or vice
        // versa). The previous connection cannot be reused for the new
        // wallet — release it so the reconnect path below targets the
        // requested device. Without this, the very next chain operation
        // would dispatch APDUs at the wrong device.
        const stateSnapshot = yield* Ref.get(state)
        const connectedType = stateSnapshot.connectedDevice?.type ?? null
        if (currentDevice && connectedType && lastDeviceType && connectedType !== lastDeviceType) {
          logger.info('Connected device type does not match requested type, releasing first', {
            origin: 'HardwareWalletService',
            connectedType,
            requestedType: lastDeviceType,
          })
          yield* Effect.either(disconnect())
        }

        const isHealthy = yield* hasHealthyConnection()
        if (isHealthy) return

        logger.info('Device not connected, attempting auto-reconnect...', {
          origin: 'HardwareWalletService',
          lastDeviceType,
          hasBleDeviceId: lastBleDeviceId !== null,
          hasStoredFactory: lastTransportFactory !== null,
        })

        confirmationManager.setWaiting({messageKey: 'reconnecting'})

        // Try BLE reconnection with stored device ID first — this creates a fresh factory
        // with the real deviceId (the initial factory may have been created with '' for first-time
        // pairing and is not suitable for reconnection).
        if (lastDeviceType === 'ledger' && lastBleDeviceId && config.createBLETransportForDevice) {
          const bleDeviceId = lastBleDeviceId
          logger.info('Attempting BLE reconnection with stored device ID', {
            origin: 'HardwareWalletService',
            bleDeviceId,
          })

          // Verify the BLE adapter is on before any retry loop — without this we'd
          // burn through three reconnect attempts (~20s) only to fail with a generic
          // transport error when the user simply has Bluetooth disabled.
          if (config.platformWaitForBluetoothReady) {
            const bleReady = yield* Effect.either(waitForBleReady(5_000))
            if (bleReady._tag === 'Left') {
              yield* updateState((s) => ({...s, lastError: bleReady.left}))
              return yield* Effect.fail(bleReady.left)
            }
          }

          // BLE reconnection after app restart often fails on the first attempt because
          // the OS Bluetooth stack hasn't re-established the connection yet. Retry up to
          // 3 times with increasing delays (1s, 2s, 4s) to give the device time to respond.
          // Each attempt is capped at 10s (vs the normal 30s connect timeout) to keep total
          // wait time reasonable (~20s worst case).
          const bleReconnect = Effect.gen(function* () {
            const bleFactory = yield* Effect.tryPromise({
              try: () =>
                config.createBLETransportForDevice?.(bleDeviceId) ?? Promise.reject(new Error('No BLE transport')),
              catch: (e) =>
                new HardwareError({
                  message: `BLE reconnection failed: ${e instanceof Error ? e.message : String(e)}`,
                  cause: e,
                }),
            })
            yield* connectLedger(bleFactory, lastLedgerConfig, bleDeviceId)
          }).pipe(
            Effect.timeoutFail({
              duration: Duration.seconds(10),
              onTimeout: () =>
                new HardwareError({
                  message: 'BLE reconnection attempt timed out',
                }),
            }),
          )

          const reconnected = yield* Effect.either(
            bleReconnect.pipe(Effect.retry(Schedule.compose(Schedule.recurs(2), Schedule.exponential('1 second')))),
          )
          if (reconnected._tag === 'Right') return

          logger.warn('BLE reconnection exhausted retries, trying fallback strategies...', {
            origin: 'HardwareWalletService',
          })
        }

        // Try reconnecting with stored factory (Ledger USB/WebHID)
        if (lastDeviceType === 'ledger' && lastTransportFactory) {
          const reconnected = yield* Effect.either(connectLedger(lastTransportFactory, lastLedgerConfig))
          if (reconnected._tag === 'Right') return

          logger.warn('Stored transport factory failed, trying alternative reconnection...', {
            origin: 'HardwareWalletService',
          })
        }

        // Try reconnecting Trezor — if we have a stored BLE device ID, attempt
        // direct reconnection (like Ledger) instead of a full 30-second scan.
        if (lastDeviceType === 'trezor') {
          if (lastBleDeviceId) {
            logger.info('Attempting Trezor BLE reconnection with stored device ID', {
              origin: 'HardwareWalletService',
              bleDeviceId: lastBleDeviceId,
            })

            // Pass the stored BLE device ID so connectTrezor can skip scanning
            // and reconnect directly to the known device.
            const reconnectTransports = trezorReconnectTransports({
              configured: lastTrezorConfig?.transports,
              transportHint: lastTransportHint,
              hasBleDeviceId: true,
            })
            const reconnectConfig = {
              ...lastTrezorConfig,
              bleDeviceId: lastBleDeviceId,
              ...(reconnectTransports === undefined ? {} : {transports: reconnectTransports}),
            }

            // Tight stall detector on the direct-open. A locked / unresponsive
            // device looks identical to an out-of-range one at the BLE / THP
            // layer — both stall the handshake silently. 5s is long enough to
            // cover a good-state reconnect (typically <1s) but short enough
            // that we fall through to the scan-fallback quickly, which gives
            // the user a chance to fix the underlying state (unlock the device,
            // turn BT back on) without staring at a spinner. The user-visible
            // troubleshooting hint in `SigningOverlay` fires at the same 5s
            // boundary by design.
            //
            // ⚠️ It must stand down once the device asks the user for
            // something. A pairing request, a PIN prompt or a button confirm IS
            // the device proving it is present and responsive, which is the
            // only thing this cap exists to detect the absence of — and pairing
            // a T3W1 runs ~17s because a human types a 6-digit code into it. A
            // flat cap cancelled the handshake mid-code-entry and the fallback
            // opened a second channel, so the device asked to pair twice while
            // the app still said "reconnecting". Past that point the wait is
            // bounded by the prompts' own UI_TIMEOUT_MS and by the BLE
            // disconnect handler.
            const reconnectStalled = Effect.gen(function* () {
              for (let waited = 0; waited < TREZOR_RECONNECT_STALL_MS; waited += TREZOR_STALL_POLL_MS) {
                yield* Effect.sleep(Duration.millis(TREZOR_STALL_POLL_MS))
                const pending = (yield* Ref.get(state)).trezorUIRequest
                if (pending !== null) {
                  logger.debug('Trezor reconnect is waiting on the user; the stall detector stands down', {
                    origin: 'HardwareWalletService',
                    request: pending.type,
                  })
                  return yield* Effect.never
                }
              }
              return yield* Effect.fail(
                new HardwareError({
                  message: 'Trezor BLE reconnection timed out',
                }),
              )
            })

            const reconnected = yield* Effect.either(Effect.raceFirst(connectTrezor(reconnectConfig), reconnectStalled))
            if (reconnected._tag === 'Right') return

            logger.warn('Trezor BLE reconnection failed, trying full scan...', {
              origin: 'HardwareWalletService',
            })
          }

          // No `bleDeviceId` — this is the scan path. It still has to scan on
          // the right transport: without the filter it enumerated USB and found
          // nothing, which is how a BLE-paired Trezor reported "No Trezor
          // devices found" twice in a row on a cold start.
          const scanTransports = trezorReconnectTransports({
            configured: lastTrezorConfig?.transports,
            transportHint: lastTransportHint,
            hasBleDeviceId: lastBleDeviceId !== null,
          })
          yield* connectTrezor({
            ...lastTrezorConfig,
            ...(scanTransports === undefined ? {} : {transports: scanTransports}),
          })
          return
        }

        const skipGenericReconnect = shouldSkipGenericLedgerReconnect({
          deviceType: lastDeviceType,
          isBLEAvailable: config.isBLEAvailable?.() ?? false,
          transportHint: lastTransportHint,
          hasBleDeviceId: lastBleDeviceId !== null,
        })

        if (config.createTransportFactory && !skipGenericReconnect) {
          const createFactory = config.createTransportFactory
          const prefer: 'usb' | 'ble' | undefined = lastTransportHint ?? undefined
          // Preserve the underlying error cause so callers can distinguish
          // "no transport at all" from "USB-preferred but device absent".
          const platformReconnect = Effect.gen(function* () {
            const factory = yield* createFactory(prefer ? {prefer} : undefined).pipe(
              Effect.mapError((e) => new HardwareError({message: e.message, cause: e})),
            )
            yield* connectLedger(factory, lastLedgerConfig)
          }).pipe(Effect.retry(Schedule.addDelay(Schedule.recurs(2), () => Duration.seconds(1))))

          const reconnected = yield* Effect.either(platformReconnect)
          if (reconnected._tag === 'Right') return

          const causeMessage =
            reconnected.left.cause instanceof Error
              ? reconnected.left.cause.message
              : String(reconnected.left.cause ?? 'unknown')
          logger.warn('Platform transport factory reconnection failed', {
            origin: 'HardwareWalletService',
            error: reconnected.left.message,
            errorTag: reconnected.left._tag,
            causeMessage,
            prefer,
            deviceType: lastDeviceType,
          })
        } else if (config.createTransportFactory && skipGenericReconnect) {
          logger.debug('Skipping generic platform reconnect for native BLE Ledger transport', {
            origin: 'HardwareWalletService',
            hasBleDeviceId: lastBleDeviceId !== null,
            hasStoredFactory: lastTransportFactory !== null,
          })
        }

        // On mobile without a stored BLE device ID, we can't silently reconnect.
        // Use DeviceNotConnectedError so the UI can map _tag to an i18n string.
        if (!lastDeviceType) {
          return yield* Effect.fail(
            new HardwareError({
              message: 'Cannot reconnect: device type unknown. Call setReconnectionInfo() before signing.',
            }),
          )
        }

        return yield* Effect.fail(
          new DeviceNotConnectedError({
            deviceType: lastDeviceType,
            message: 'Hardware wallet disconnected. Please reconnect your device.',
          }),
        )
      })

    const ensureApp = (
      chain: ChainId,
      options?: {
        readonly forceReopen?: boolean
        readonly allowReconnectOnOpenAppError?: boolean
      },
    ): Effect.Effect<void, HardwareErrorType> => {
      // Only the switch itself re-enumerates USB — not the pre-sign probe or the
      // "app already open" short-circuit. Guard from the switch decision onward so
      // a real unplug during a routine probe still triggers listener teardown.
      let didEnterSwitch = false
      return Effect.gen(function* () {
        // Trezor handles app switching internally
        if (lastDeviceType === 'trezor') return

        const appInfo = getAppForChain(chain)
        if (!appInfo) {
          return yield* Effect.fail(
            new HardwareError({
              message: `Chain ${chain} is not supported on Ledger`,
            }),
          )
        }

        // Read the cached app name for logging and UI hints, but do not treat it
        // as the source of truth. The user can manually leave the app, the device
        // can lock, or the OS can reset the transport while our in-memory state
        // still says the target app is open. Always probe the device before
        // short-circuiting, unless we are explicitly force-reopening.
        const currentState = yield* Ref.get(state)

        // Probe the device to detect the actual running app. This is needed because:
        // 1. After app restart, currentApp may be stale or null and we don't know what's running.
        // 2. The user may have manually switched apps on the device.
        // 3. On BLE, blindly calling openApp when the correct app is already open
        //    would close+reopen it, dropping the GATT connection unnecessarily.
        if (currentDevice) {
          if (currentDevice.getRunningAppName) {
            // SAFETY: never skip the pre-sign BOLOS probe based on a cache.
            // A user can manually switch apps on the device between probes,
            // and our cache can't observe that. Trusting a stale cache here
            // would dispatch a chain APDU to the wrong app — observed in
            // the field as "ETH sign on Solana app" producing an invalid
            // signature that still slipped through the upstream broadcast
            // path. The probe is one BLE round-trip (~50 ms), cheaper than
            // any wrong-app recovery loop.
            let nameResult = yield* Effect.either(currentDevice.getRunningAppName())
            // Transient APDU state mismatch immediately after unlock (Android
            // USB Ledger) presents as "Invalid sequence" on the BOLOS probe.
            // The Java transport layer's response parser is not lying — the
            // device really did emit an out-of-band sequence — but the cause
            // is "we asked too soon", not "the device is broken". Settle
            // briefly and retry the probe once; the second attempt
            // routinely succeeds on warm transport. On retry success, fall
            // through to the canonical Right-branch handling below — do
            // not duplicate the switch-app + reconnect-on-error logic
            // here, that path owns the recovery hooks.
            if (
              nameResult._tag === 'Left' &&
              isTransientApduError(nameResult.left.message) &&
              nameResult.left._tag !== 'DeviceLockedError'
            ) {
              logger.warn('BOLOS probe hit transient APDU error; retrying after settle', {
                origin: 'HardwareWalletService',
                targetApp: appInfo.appName,
                probeErrorMessage: nameResult.left.message,
                transportHint: lastTransportHint,
              })
              yield* Effect.sleep(Duration.millis(500))
              const retryResult = yield* Effect.either(currentDevice.getRunningAppName())
              if (retryResult._tag === 'Right') {
                logger.info('BOLOS post-settle retry succeeded', {
                  origin: 'HardwareWalletService',
                  runningApp: retryResult.right,
                  targetApp: appInfo.appName,
                })
              } else {
                logger.warn('BOLOS post-settle retry failed', {
                  origin: 'HardwareWalletService',
                  retryErrorTag: retryResult.left._tag,
                  retryErrorMessage: retryResult.left.message,
                })
              }
              // Adopt the retry result unconditionally. The downstream Left
              // branch dispatches on `_tag` — if the user locked the device
              // during the 500ms settle, the retry surfaces a
              // `DeviceLockedError` whose lock-specific recovery is more
              // actionable than the stale transient-APDU tag we'd preserve
              // by keeping the original.
              nameResult = retryResult
            }

            if (nameResult._tag === 'Right') {
              const runningName = nameResult.right
              logger.info('Detected running app via BOLOS APDU', {
                origin: 'HardwareWalletService',
                runningApp: runningName,
                targetApp: appInfo.appName,
                forceReopen: options?.forceReopen ?? false,
              })
              lastProbeAtMs = Date.now()
              yield* updateState((s) => ({...s, currentApp: runningName}))
              if (!options?.forceReopen && runningName === appInfo.appName) return
              // Wrong app — fall through to openApp (cache stays valid until
              // openApp succeeds; the closeApp/openApp path resets state below
              // and the next ensureApp call will re-probe regardless).
            } else {
              if (nameResult.left._tag === 'DeviceLockedError') {
                logger.warn('BOLOS probe hit locked device; surfacing DeviceLockedError', {
                  origin: 'HardwareWalletService',
                  targetApp: appInfo.appName,
                  transportHint: lastTransportHint,
                })
                if (shouldResetTransportOnLockedDevice(lastTransportHint)) {
                  const dr = yield* Effect.either(disconnect())
                  if (dr._tag === 'Left') {
                    logger.warn('disconnect failed during USB locked-device BOLOS-probe reset', {
                      origin: 'HardwareWalletService',
                      error: dr.left.message,
                    })
                  }
                }
                return yield* Effect.fail(nameResult.left)
              }
              // iOS BLE notify can go half-open: link layer reports
              // connected but indications never arrive. App-specific
              // probe first; if it also fails, cycle the transport.
              logger.warn('BOLOS probe failed, trying app-specific probe', {
                origin: 'HardwareWalletService',
                targetApp: appInfo.appName,
                probeErrorTag: nameResult.left._tag,
                probeErrorMessage: nameResult.left.message,
              })
              const isAppOpen = yield* probeLedgerAppOpen(currentDevice, chain)
              if (isAppOpen && !options?.forceReopen) {
                logger.info('App already open (detected via app-specific fallback)', {
                  origin: 'HardwareWalletService',
                  appName: appInfo.appName,
                })
                yield* updateState((s) => ({
                  ...s,
                  currentApp: appInfo.appName,
                }))
                return
              }
              // Both probes silent — treat as half-open. `allowReconnectOnOpenAppError`
              // guards against infinite recursion if the recycled link is also dead.
              if (!options?.forceReopen && (options?.allowReconnectOnOpenAppError ?? true)) {
                logger.warn('Half-open BLE notify suspected; cycling transport and retrying ensureApp once', {
                  origin: 'HardwareWalletService',
                  targetApp: appInfo.appName,
                })
                yield* Effect.either(disconnect())
                yield* ensureConnected()
                return yield* ensureApp(chain, {
                  forceReopen: false,
                  allowReconnectOnOpenAppError: false,
                })
              }
            }
          } else {
            const isAppOpen = yield* probeLedgerAppOpen(currentDevice, chain)
            if (isAppOpen && !options?.forceReopen) {
              logger.info('App already open (detected via app-specific probe)', {
                origin: 'HardwareWalletService',
                appName: appInfo.appName,
              })
              yield* updateState((s) => ({
                ...s,
                currentApp: appInfo.appName,
              }))
              return
            }
          }
          logger.debug('Will attempt to switch app', {
            origin: 'HardwareWalletService',
            targetApp: appInfo.appName,
          })
        }

        yield* Effect.sync(() => {
          didEnterSwitch = true
          appSwitchGuard.enter()
        })

        // Open the correct app
        if (!currentDevice?.openApp) {
          return yield* Effect.fail(
            new AppNotOpenError({
              expectedApp: appInfo.appName,
              ...(currentState.currentApp != null && {
                currentApp: currentState.currentApp,
              }),
            }),
          )
        }

        logger.info('Switching Ledger app', {
          origin: 'HardwareWalletService',
          from: currentState.currentApp,
          to: appInfo.appName,
        })

        confirmationManager.setWaiting({
          messageKey: 'open-app',
          messageParams: {appName: appInfo.appName},
        })

        const openAppResult = yield* Effect.either(currentDevice.openApp(appInfo.appName))
        if (openAppResult._tag === 'Left') {
          const openAppError = openAppResult.left
          invalidateProbeCache()
          yield* updateState((s) => ({...s, currentApp: null}))

          // Do not gate reconnect on currentDevice.isConnected().
          // After a rejected signature followed by exiting the app/dashboard on device,
          // the transport can already be stale or logically dead even if the retry path
          // still sees an openApp failure. In that situation a full disconnect +
          // reconnect + force-reopen cycle is exactly what we want to attempt.
          const shouldReconnect =
            (options?.allowReconnectOnOpenAppError ?? true) && shouldReconnectAfterOpenAppError(openAppError)

          if (shouldReconnect) {
            logger.warn('Ledger openApp failed; reconnecting and retrying once', {
              origin: 'HardwareWalletService',
              chain,
              expectedApp: appInfo.appName,
              errorTag: openAppError._tag,
              errorMessage: openAppError.message,
            })
            yield* Effect.either(disconnect())
            yield* ensureConnected()
            return yield* ensureApp(chain, {
              forceReopen: true,
              allowReconnectOnOpenAppError: false,
            })
          }

          return yield* Effect.fail(openAppError)
        }
        yield* updateState((s) => ({...s, currentApp: appInfo.appName}))

        // On BLE, openApp drops the GATT connection — reconnect before continuing.
        // The bridge tab/offscreen handles retries with delays internally.
        // On USB, wait for the app to fully initialize before proceeding.
        if (!currentDevice.isConnected()) {
          // Model-aware pre-reconnect sleep: Nano X needs more time to restart
          // BLE advertising than Stax/Flex/Gen 5. See `ble-timings.ts`.
          const ledgerModel = currentDevice.getLedgerModel?.() ?? null
          const preReconnectMs = getBleSwitchTimings(ledgerModel).preReconnectMs
          logger.debug('Reconnecting after app switch (BLE connection dropped)', {
            origin: 'HardwareWalletService',
            ledgerModel,
            preReconnectMs,
          })
          confirmationManager.setWaiting({
            messageKey: 'waiting-for-app',
            messageParams: {appName: appInfo.appName},
          })
          yield* Effect.sleep(preReconnectMs)
          yield* ensureConnected()
        } else {
          // USB: wait for the app to initialize, then verify it's ready by probing.
          // The Cardano app can take 2-3s to become responsive after launch.
          yield* Effect.sleep(500)
        }

        // Verify the app is running via BOLOS APDU (safe — doesn't send app-specific
        // commands that could interfere with initialization). Retry up to 5 times.
        // Fail fast after this bounded switch/reconnect cycle so the UI surfaces a
        // concrete error instead of rotating between reconnect/open-app states.
        if (currentDevice.getRunningAppName) {
          const verifyResult = yield* Effect.either(
            pipe(
              currentDevice.getRunningAppName(),
              Effect.flatMap((name) =>
                name === appInfo.appName
                  ? Effect.void
                  : Effect.fail(
                      new AppNotOpenError({
                        expectedApp: appInfo.appName,
                        currentApp: name,
                      }),
                    ),
              ),
              Effect.retry(Schedule.addDelay(Schedule.recurs(5), () => Duration.millis(500))),
            ),
          )

          if (verifyResult._tag === 'Left') {
            const isAppOpen = yield* probeLedgerAppOpen(currentDevice, chain)
            if (isAppOpen) {
              lastProbeAtMs = Date.now()
              yield* updateState((s) => ({
                ...s,
                currentApp: appInfo.appName,
              }))
              yield* Effect.sleep(500)
              return
            }

            invalidateProbeCache()
            yield* updateState((s) => ({...s, currentApp: null}))
            logger.warn('Ledger app verification failed after switch', {
              origin: 'HardwareWalletService',
              expectedApp: appInfo.appName,
              errorTag: verifyResult.left._tag,
              errorMessage: verifyResult.left.message,
            })
            return yield* Effect.fail(verifyResult.left)
          }

          // Verify succeeded — record the probe timestamp so a follow-up
          // `hasHealthyConnection` ping within the same window can skip
          // its own BOLOS round-trip.
          lastProbeAtMs = Date.now()

          // Extra delay for the app to finish internal initialization after BOLOS reports it
          yield* Effect.sleep(500)
        }
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (didEnterSwitch) appSwitchGuard.exit()
          }),
        ),
      )
    }

    const ensureAccountCached = (chain: ChainId, accountIndex: number): Effect.Effect<void, HardwareErrorType> =>
      Effect.gen(function* () {
        const cachedAccount = accountCache.get(getAccountCacheKey(chain, accountIndex))
        if (isHardwareAccountCacheEntryCompatible(cachedAccount, chain, accountIndex, lastDeviceType)) {
          return
        }
        if (cachedAccount) {
          logger.debug('Refreshing incompatible cached account entry for requested chain', {
            origin: 'HardwareWalletService',
            chain,
            accountIndex,
            cachedPath: cachedAccount.path,
            expectedPath: getExpectedAccountCachePath(chain, accountIndex, lastDeviceType),
          })
        }
        yield* getAccount(chain, accountIndex)
      })

    const ensureReady = (chain: ChainId, accountIndex?: number): Effect.Effect<void, HardwareErrorType> =>
      Effect.gen(function* () {
        yield* ensureConnected()
        yield* ensureApp(chain)
        if (accountIndex !== undefined) {
          yield* ensureAccountCached(chain, accountIndex)
        }
      })

    const recoverLedgerStaleSession = (chain: ChainId, error: unknown): Effect.Effect<void, HardwareErrorType> =>
      Effect.gen(function* () {
        logger.warn('Stale session or app not ready, force-reopening app and retrying...', {
          origin: 'HardwareWalletService',
          chain,
          errorMessage: error instanceof Error ? error.message : String(error),
        })
        invalidateProbeCache()
        yield* updateState((s) => ({...s, currentApp: null}))
        yield* Effect.sleep(500)
        // A stale session is primarily an app-state problem, not a transport problem.
        // If the device is still connected, avoid eager BLE health probing here —
        // it can downgrade a recoverable app issue into a long reconnect loop.
        if (!currentDevice?.isConnected()) {
          yield* ensureConnected()
        }
        yield* ensureApp(chain, {forceReopen: true})
      })

    /** Execute a chain operation with app-not-open error recovery (retry once after switching app) */
    const withAppRecovery = <A>(
      chain: ChainId,
      operation: () => Effect.Effect<A, HardwareErrorType>,
    ): Effect.Effect<A, HardwareErrorType> =>
      Effect.gen(function* () {
        const result = yield* Effect.either(operation())
        if (result._tag === 'Right') return result.right

        const error = result.left
        const recoveryStrategy = resolveLedgerAppRecoveryStrategy(error)
        if (recoveryStrategy === 'retry') {
          logger.warn('Wrong app detected, switching and retrying...', {
            origin: 'HardwareWalletService',
            chain,
          })
          // Reset currentApp so ensureApp will switch
          invalidateProbeCache()
          yield* updateState((s) => ({...s, currentApp: null}))
          yield* ensureApp(chain)
          return yield* operation()
        }

        if (recoveryStrategy === 'force-reopen') {
          // Stale sessions need a full close/open cycle. A normal ensureApp()
          // would probe BOLOS, see the correct app, and skip the reopen.
          yield* recoverLedgerStaleSession(chain, error)
          return yield* operation()
        }

        // Any other APDU-level failure invalidates the cached app state.
        // Without this, ensureApp short-circuits on the next call because
        // currentApp still says the correct app is open, even though the
        // device may have locked, the app may have crashed, or the transport
        // may be in a bad state. Clearing forces ensureApp to re-probe.
        invalidateProbeCache()
        yield* updateState((s) => ({...s, currentApp: null}))
        return yield* Effect.fail(error)
      })

    const setReconnectionInfo = (info: {
      readonly deviceType: DeviceType
      readonly bleDeviceId?: string
      readonly transportHint?: 'usb' | 'ble'
    }): void => {
      // Always overwrite — when the user switches between a Ledger-imported
      // wallet and a Trezor-imported wallet, the next signing request must
      // route to the device that owns the destination wallet, not the
      // device that was last connected. Cross-device transport hints
      // (`lastBleDeviceId` / `lastTransportFactory`) are cleared when the
      // requested type differs so the reconnect path doesn't try a Ledger
      // BLE id while attempting to reach a Trezor (and vice versa).
      const previousDeviceType = lastDeviceType
      lastDeviceType = info.deviceType
      if (previousDeviceType !== null && previousDeviceType !== info.deviceType) {
        lastBleDeviceId = null
        lastTransportFactory = null
        lastTransportHint = null
      }
      const transportState = resolveSeededLedgerTransportState(info)
      lastBleDeviceId = transportState.bleDeviceId
      lastTransportHint = transportState.transportHint
      logger.debug('Reconnection info seeded', {
        origin: 'HardwareWalletService',
        deviceType: lastDeviceType,
        previousDeviceType,
        hasBleDeviceId: lastBleDeviceId !== null,
        transportHint: lastTransportHint,
        hasStoredFactory: lastTransportFactory !== null,
      })
    }

    const resolveTrezorPin = (pin: string): void => {
      pinResolve?.(pin)
      pinResolve = null
      pinReject = null
      Effect.runSync(updateState((s) => ({...s, trezorUIRequest: null})))
    }

    const rejectTrezorPin = (): void => {
      pinReject?.()
      pinResolve = null
      pinReject = null
      Effect.runSync(updateState((s) => ({...s, trezorUIRequest: null})))
    }

    const resolveTrezorPassphrase = (value: string, passphraseOnDevice?: boolean): void => {
      passphraseResolve?.(passphraseOnDevice !== undefined ? {value, passphraseOnDevice} : {value})
      passphraseResolve = null
      passphraseReject = null
      Effect.runSync(updateState((s) => ({...s, trezorUIRequest: null})))
    }

    const rejectTrezorPassphrase = (): void => {
      passphraseReject?.()
      passphraseResolve = null
      passphraseReject = null
      Effect.runSync(updateState((s) => ({...s, trezorUIRequest: null})))
    }

    const resolvePairingCode = (code: string): void => {
      pairingCodeResolve?.(code)
      pairingCodeResolve = null
      pairingCodeReject = null
      Effect.runSync(updateState((s) => ({...s, trezorUIRequest: null})))
    }

    const rejectPairingCode = (): void => {
      pairingCodeReject?.()
      pairingCodeResolve = null
      pairingCodeReject = null
      Effect.runSync(updateState((s) => ({...s, trezorUIRequest: null})))
    }

    return {
      state,
      confirmationManager,
      getState,
      scanDevices,
      startBLEScan,
      startUsbScan,
      listUSBDevices,
      connectLedger,
      connectTrezor,
      disconnect,
      quitApp,
      isConnected,
      isSwitchingApp,
      getAccounts,
      getAccount,
      ensureReady,
      setReconnectionInfo,
      verifyAddress,
      getDeviceInfo,
      getDeviceFeatures,
      getAppVersion,
      openApp,
      getCurrentDevice: () => currentDevice,
      getAccountCache: (chain: ChainId) => filterAccountCacheByChain(accountCache, chain),
      withAppRecovery,
      resolveTrezorPin,
      rejectTrezorPin,
      resolveTrezorPassphrase,
      rejectTrezorPassphrase,
      resolvePairingCode,
      rejectPairingCode,
    }
  })

/**
 * Create HardwareWalletService layer.
 */
export const HardwareWalletServiceLayer = (config?: HardwareWalletServiceConfig) =>
  Layer.effect(HardwareWalletServiceTag, createHardwareWalletService(config))
