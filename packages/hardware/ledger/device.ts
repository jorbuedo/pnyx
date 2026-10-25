/**
 * Ledger device implementation.
 *
 * Provides Effect-based interface for Ledger hardware wallet operations.
 *
 * @module
 */

import CardanoAppDefault, {
  AddressType,
  Ada as CardanoAppAda,
  CIP36VoteDelegationType,
  CIP36VoteRegistrationFormat,
  TxAuxiliaryDataType,
} from '@cardano-foundation/ledgerjs-hw-app-cardano'
import {buildLedgerSignRequest as convertToLedgerRequest} from '@evolution-sdk/hardware-cardano/Ledger'
import {blake2b} from '@noble/hashes/blake2.js'
import {getLogger} from '@pnyx/logger'
import {Duration, Effect, pipe} from 'effect'
import {parseTransactionBody} from '../cardano/parse-tx-body'
import type {
  AppVersion,
  CardanoAppCapabilities,
  CardanoMessageAddressParams,
  CardanoSigningRequest,
  ChainAppType,
  CIP36RegistrationParams,
  DeviceFeatures,
  ExtendedPublicKey,
  HardwareDevice,
  HardwareSignature,
  LedgerConfig,
  LedgerModel,
  MessageSigningRequest,
  TransactionWitness,
} from '../types'
import {
  DeviceNotConnectedError,
  DevicePairingLostError,
  DeviceTimeoutError,
  HardwareError,
  type HardwareErrorType,
  IncorrectDeviceError,
  LEDGER_CIP36_VERSION,
  LEDGER_CIP1694_VERSION,
  MIN_LEDGER_CARDANO_VERSION,
  TransportError,
} from '../types'
import {bytesToHex, compressSecp256k1PublicKey, hexToBytes, parseDerivationPath, requireDerivationPath} from '../utils'
import {createBitcoinLedgerApp} from './apps/bitcoin'
import {createEthereumLedgerApp} from './apps/ethereum'
import {createSolanaLedgerApp} from './apps/solana'
import {createTronLedgerApp} from './apps/tron'
import {createBitcoinCashLedgerApp, createDogecoinLedgerApp, createLitecoinLedgerApp} from './apps/utxo-variants'
import {getBleSwitchTimings} from './ble-timings'
import {
  isAppNotOpenError,
  isPairingLostError,
  isWrongAppError,
  mapLedgerError,
  mapLedgerOpenAppError,
  mapLedgerOsCommandError,
  meetsMinimumVersion,
  parseVersion,
  validateAppVersion,
} from './errors'
import {ledgerSigningModeFor} from './signing-mode'
import type {
  LedgerAuxiliaryData,
  LedgerCIP36VoteDelegation,
  LedgerConnectionState,
  LedgerConnectOptions,
  LedgerDeviceFeatures,
  LedgerGetExtendedPublicKeyResponse,
  LedgerMessageAddress,
  LedgerSignMessageRequest,
  LedgerSignTxRequest,
  LedgerTransport,
  LedgerTransportFactory,
} from './types'

/**
 * Map a chain-agnostic CIP-8 address descriptor to the Ledger library's
 * DeviceOwnedAddress shape for ADDRESS-mode message signing.
 */
const toLedgerDeviceOwnedAddress = (params: CardanoMessageAddressParams): LedgerMessageAddress => {
  switch (params.type) {
    case 'reward':
      return {
        type: AddressType.REWARD_KEY,
        params: {stakingPath: requireDerivationPath(params.stakingPath, 'reward address stakingPath')},
      }
    case 'enterprise':
      return {
        type: AddressType.ENTERPRISE_KEY,
        params: {spendingPath: requireDerivationPath(params.spendingPath, 'enterprise address spendingPath')},
      }
    default:
      return {
        type: AddressType.BASE_PAYMENT_KEY_STAKE_KEY,
        params: {
          spendingPath: requireDerivationPath(params.spendingPath, 'base address spendingPath'),
          stakingPath: requireDerivationPath(params.stakingPath, 'base address stakingPath'),
        },
      }
  }
}

/**
 * Ledger USB product IDs for model detection.
 * These are the known product IDs from Ledger devices.
 */
const LEDGER_PRODUCT_IDS = {
  // Nano S
  4113: 'nanoS',
  4117: 'nanoS', // Nano S bootloader
  // Nano S Plus
  20497: 'nanoSPlus',
  20501: 'nanoSPlus', // Nano S Plus bootloader
  // Nano X
  16401: 'nanoX',
  16405: 'nanoX', // Nano X bootloader
  4: 'nanoX', // Nano X via BLE
  // Nano Gen5
  128: 'nanoGen5', // 0x80
  8: 'nanoGen5', // 0x0008 bootloader
  // Stax
  24593: 'stax',
  24597: 'stax', // Stax bootloader
  // Flex
  28689: 'flex',
  28693: 'flex', // Flex bootloader
} as const

/**
 * Detects the Ledger model from transport information.
 *
 * @param transport - Ledger transport with device model info
 * @param useUSB - Whether USB transport is being used
 * @returns Detected Ledger model
 */
const detectLedgerModel = (transport: LedgerTransport, useUSB: boolean): LedgerModel => {
  // Try to get deviceModel from transport (available in newer Ledger transport libs)
  const transportWithModel = transport as unknown as {
    deviceModel?: {
      id: string
      productName?: string
      productIdMM?: number
      legacyUsbProductId?: number
      usbOnly?: boolean
      memorySize?: number
      masks?: number[]
      bluetoothSpec?: string[]
    }
  }

  if (transportWithModel.deviceModel) {
    const {id, productIdMM} = transportWithModel.deviceModel

    // Check by model ID string (most reliable)
    const modelIdMap: Record<string, LedgerModel> = {
      nanoS: 'nanoS',
      nanoSP: 'nanoSPlus',
      nanoSPlus: 'nanoSPlus',
      nanoX: 'nanoX',
      stax: 'stax',
      europa: 'flex', // @ledgerhq/devices uses 'europa' for Flex
      flex: 'flex',
      apex: 'nanoGen5', // @ledgerhq/devices uses 'apex' for Nano Gen5
    }

    if (id && modelIdMap[id]) {
      return modelIdMap[id]
    }

    // Check by product ID
    if (productIdMM !== undefined) {
      const model = LEDGER_PRODUCT_IDS[productIdMM as keyof typeof LEDGER_PRODUCT_IDS]
      if (model) return model
    }
  }

  // Try to get product ID from USB descriptor
  const transportWithDevice = transport as unknown as {
    device?: {productId?: number}
  }

  if (transportWithDevice.device?.productId !== undefined) {
    const model = LEDGER_PRODUCT_IDS[transportWithDevice.device.productId as keyof typeof LEDGER_PRODUCT_IDS]
    if (model) return model
  }

  // BLE: Nano X is most common, but Stax/Flex/Gen5 also support BLE.
  // Without product info we can't distinguish — Nano X is the safest default.
  if (!useUSB) {
    return 'nanoX'
  }

  // Default fallback - Nano X is the most common model
  return 'nanoX'
}

/**
 * Resolves as soon as the transport emits a 'disconnect' event. Used to
 * race against BLE `transport.send(...)` calls whose Promises do not reject
 * when the GATT connection drops — observed on iOS with
 * `@ledgerhq/react-native-hw-transport-ble` after BOLOS openApp completes
 * on-device. Without this race the openApp Effect would block forever.
 */
const awaitTransportDisconnect = (transport: LedgerTransport): Effect.Effect<void, never> =>
  Effect.async<void>((resume) => {
    if (!transport.on) return
    const handler = () => resume(Effect.void)
    transport.on('disconnect', handler)
    return Effect.sync(() => transport.off?.('disconnect', handler))
  })

/**
 * Abort timeout for BOLOS probe APDUs on BLE transport.
 *
 * Without an explicit `abortTimeoutMs`, `@ledgerhq/react-native-hw-transport-ble`
 * does not call `cancelPendingOperations()` on a stalled exchange, so the
 * underlying Promise never rejects when the iOS GATT silently drops. For
 * BOLOS APDUs (CLA 0xb0 — get-app-and-version, quit-app) this matters
 * because they are the building blocks of `hasHealthyConnection` /
 * `ensureApp` / `getRunningAppName` — the pre-sign health probes that
 * detect dead GATT and trigger the disconnect + reconnect path.
 *
 * Non-BOLOS app APDUs (sign / showAddress / clear-signing) deliberately
 * pass through WITHOUT a timeout. They can legitimately wait many minutes
 * for user approval on the device, and a wrapper-level timeout would
 * false-positive on slow approvers — a UX failure that's worse than the
 * rare hang scenario (which is recoverable via the in-app Cancel button
 * wired through `cancelHardwareSigning`).
 */
const BLE_APDU_PROBE_TIMEOUT_MS = 1_500

/**
 * Detects whether a transport instance is a BLE BleTransport from
 * `@ledgerhq/react-native-hw-transport-ble`. Used to gate the APDU-timeout
 * wrapper since `abortTimeoutMs` is BLE-specific and USB / HID transports
 * do not need (and may ignore) the parameter.
 */
const isBleTransport = (transport: LedgerTransport): boolean => {
  // biome-ignore lint/suspicious/noExplicitAny: runtime shape probe
  const t = transport as any
  return typeof t.exchange === 'function' && 'unresponsiveTimeout' in t
}

/**
 * Wraps a BLE LedgerTransport so that BOLOS probe APDUs (CLA 0xb0) carry
 * an `abortTimeoutMs`. Without it, the pre-sign `hasHealthyConnection`
 * probe could itself hang on a half-open iOS GATT — defeating the whole
 * recovery flow. With the timeout, the probe rejects within 5s and the
 * service tears down + reconnects before any sign APDU is dispatched.
 *
 * Non-BOLOS APDUs pass through untouched so slow user approvals are not
 * cut off by a wrapper-level timeout.
 *
 * Idempotent (safe to call repeatedly on the same transport).
 */
const wrapBleTransportWithApduTimeout = (transport: LedgerTransport): LedgerTransport => {
  // biome-ignore lint/suspicious/noExplicitAny: monkey-patch sentinel + extended signatures
  const t = transport as any
  if (t.__sf_apduTimeoutWrapped) return transport

  const originalSend = t.send.bind(t) as (...args: unknown[]) => Promise<Uint8Array>

  t.send = (
    cla: number,
    ins: number,
    p1: number,
    p2: number,
    data?: Uint8Array,
    statusList?: number[],
    options?: {abortTimeoutMs?: number},
  ): Promise<Uint8Array> => {
    // Caller-supplied options always win.
    if (options?.abortTimeoutMs !== undefined) {
      return originalSend(cla, ins, p1, p2, data, statusList, options)
    }
    // BOLOS probes get a short safety timeout. Everything else is
    // intentionally un-timed — see the constant doc-comment above.
    if (cla === 0xb0) {
      return originalSend(cla, ins, p1, p2, data, statusList, {abortTimeoutMs: BLE_APDU_PROBE_TIMEOUT_MS})
    }
    return originalSend(cla, ins, p1, p2, data, statusList)
  }

  t.__sf_apduTimeoutWrapped = true
  return transport
}

/**
 * Sends a BLE APDU whose response is fire-and-forget — the device side
 * effect happens, but the transport may never deliver the reply (e.g.
 * BOLOS close-app / open-app cause GATT to drop). Returns when the send
 * resolves, when the transport disconnects, or when the safety-net
 * timeout fires, whichever comes first. Errors from the underlying
 * transport are swallowed (BLE drop is expected); upstream callers
 * verify success via a follow-up probe (`getRunningAppName`).
 */
const BLE_FIRE_AND_FORGET_SAFETY_NET_MS = 4_000
// USB open-app blocks on an on-device user confirmation before a Nano S
// re-enumerates, so the wait must cover a human reaction window (the
// 'disconnect' race ends it early the moment the device re-enumerates).
// Expiry means the user never confirmed nor denied — the dialog is still up
// on the device — and is surfaced as a DeviceTimeoutError, not swallowed.
const logger = getLogger('hardware')

const USB_OPEN_APP_CONFIRM_TIMEOUT_MS = 60_000
// USB close-app never waits on user confirmation — the device either ACKs
// promptly or re-enumerates (which ends the race via 'disconnect'), so a
// short net like the BLE one suffices.
const USB_CLOSE_APP_FIRE_AND_FORGET_SAFETY_NET_MS = 4_000

/**
 * Send an APDU but stop awaiting it the moment the transport drops (the device
 * reboots its USB/BLE stack on an app switch and the pending send never
 * resolves on the dead handle). Races the send against the 'disconnect' event
 * with a safety-net timeout; the service layer reconnects and verifies the
 * running app afterward. A transport drop is the expected outcome and a real
 * failure surfaces at the verify step, so the error is logged, not raised.
 */
const sendFireAndForget = <E>(
  transport: LedgerTransport,
  send: Effect.Effect<Uint8Array, E>,
  context: string,
  transportType: 'bluetooth' | 'usb',
  safetyNetMs: number,
): Effect.Effect<void, never> =>
  pipe(
    Effect.raceFirst(send, awaitTransportDisconnect(transport).pipe(Effect.as(new Uint8Array()))),
    Effect.timeoutFail({
      duration: Duration.millis(safetyNetMs),
      onTimeout: () =>
        new TransportError({
          transportType,
          message: `${context} timed out after ${safetyNetMs}ms — no transport response and no disconnect event`,
        }),
    }),
    Effect.catchAll((e) => {
      logger.debug('Fire-and-forget APDU ended without a response', {
        origin: 'LedgerDevice',
        context,
        transportType,
        error: String(e),
      })
      return Effect.void
    }),
  )

const sendBleFireAndForget = <E>(
  transport: LedgerTransport,
  send: Effect.Effect<Uint8Array, E>,
  context: string,
): Effect.Effect<void, never> =>
  sendFireAndForget(transport, send, context, 'bluetooth', BLE_FIRE_AND_FORGET_SAFETY_NET_MS)

/**
 * Bound an informational BOLOS probe. A USB send on a device stuck in a UX
 * dialog (e.g. an unconfirmed open-app) neither resolves nor rejects, and
 * unlike BLE there is no abortTimeoutMs — without a bound the probe hangs
 * the calling flow forever. Probes never wait on user interaction, so a
 * tight timeout is safe; signing/approval APDUs stay unbounded by design.
 */
const BOLOS_PROBE_TIMEOUT_MS = 3_000

const boundProbe = <A, E>(probe: Effect.Effect<A, E>, operation: string): Effect.Effect<A, E | DeviceTimeoutError> =>
  probe.pipe(
    Effect.timeoutFail({
      duration: Duration.millis(BOLOS_PROBE_TIMEOUT_MS),
      onTimeout: () => new DeviceTimeoutError({operation, timeoutMs: BOLOS_PROBE_TIMEOUT_MS}),
    }),
  )

/**
 * Creates a Ledger device instance.
 *
 * @param transportFactory - Factory for creating Ledger transports
 * @param config - Ledger configuration
 * @returns HardwareDevice implementation for Ledger
 */
export const createLedgerDevice = (transportFactory: LedgerTransportFactory, config: LedgerConfig): HardwareDevice => {
  // Internal state
  let state: LedgerConnectionState = {
    connected: false,
  }

  // Cardano app instance (lazily created)
  let cardanoApp: CardanoApp | null = null

  /**
   * Gets or creates a transport connection to the device.
   * Does NOT require any specific app to be open — only establishes the transport layer.
   */
  const getTransport = (options?: LedgerConnectOptions): Effect.Effect<LedgerTransport, HardwareErrorType> =>
    Effect.gen(function* () {
      // Return existing transport if available and still alive.
      // BleTransport exposes an isConnected flag that reflects the actual GATT state —
      // check it to catch cases where BLE dropped but the "disconnect" event hasn't
      // fired yet (race window).
      if (state.connected && state.transport) {
        const transportAny = state.transport as Record<string, unknown>
        if (transportAny.isConnected === false) {
          state = {connected: false}
          cardanoApp = null
        } else {
          return state.transport
        }
      }

      // Create new transport
      const transport = yield* Effect.tryPromise({
        try: async () => {
          if (options?.useUSB === false && options?.bleDeviceId && transportFactory.open) {
            return await transportFactory.open(options.bleDeviceId)
          }
          if (options?.deviceObj && transportFactory.open) {
            return await transportFactory.open(options.deviceObj)
          }
          return await transportFactory.create()
        },
        catch: (error) => {
          // iOS surfaces `PeerRemovedPairing` from @ledgerhq/react-native-hw-transport-ble
          // when the Ledger has dropped its bond but the phone still holds stale pairing
          // keys. Reconnecting alone does not recover — the user must forget the device
          // in OS Bluetooth settings and re-pair.
          if (isPairingLostError(error)) {
            return new DevicePairingLostError({
              deviceType: 'ledger',
              message: error instanceof Error ? error.message : 'Bluetooth pairing removed',
            })
          }
          return new TransportError({
            transportType: options?.useUSB !== false ? 'usb' : 'bluetooth',
            message: error instanceof Error ? error.message : String(error),
            cause: error,
          })
        },
      })

      // Set timeout if configured
      if (config.timeout && transport.setExchangeTimeout) {
        transport.setExchangeTimeout(config.timeout)
      }

      // On BLE, every APDU must carry an abortTimeoutMs — otherwise a stalled
      // exchange on a half-open iOS GATT never rejects and the UI hangs on
      // "review and approve on device" forever. The wrapper is idempotent
      // and a no-op on USB transports (gated by isBleTransport).
      if (isBleTransport(transport)) {
        wrapBleTransportWithApduTimeout(transport)
      }

      // Small delay for APDU settlement
      yield* Effect.sleep(50)

      // Detect Ledger model from transport
      const isUSB = options?.useUSB !== false
      const detectedModel = detectLedgerModel(transport, isUSB)

      // Get human-readable model name for display
      const modelDisplayNames: Record<LedgerModel, string> = {
        nanoS: 'Ledger Nano S',
        nanoSPlus: 'Ledger Nano S Plus',
        nanoX: 'Ledger Nano X',
        nanoGen5: 'Ledger Nano Gen5',
        stax: 'Ledger Stax',
        flex: 'Ledger Flex',
      }

      // Listen for transport-level disconnect events (BLE drops, USB unplug).
      // This keeps isConnected() accurate so ensureConnected() triggers reconnection
      // instead of trusting a stale true flag.
      //
      // Preserve `features` (and `deviceInfo`) across the wipe so the device
      // model survives a transient GATT drop — model-aware BLE timings + UI
      // labels depend on reading it before the reconnect re-detects.
      if (transport.on) {
        transport.on('disconnect', () => {
          state = {
            connected: false,
            ...(state.features !== undefined && {features: state.features}),
            ...(state.deviceInfo !== undefined && {deviceInfo: state.deviceInfo}),
          }
          cardanoApp = null
        })
      }

      // Update state with transport info (no app-specific info yet)
      state = {
        connected: true,
        transport,
        transportType: isUSB ? 'usb' : 'bluetooth',
        deviceInfo: {
          type: 'ledger',
          model: modelDisplayNames[detectedModel],
          deviceId: '',
          firmwareVersion: '',
          status: 'connected',
          transportType: isUSB ? 'usb' : 'bluetooth',
        },
        features: {
          type: 'ledger',
          model: detectedModel,
          deviceId: '',
          firmwareVersion: '',
          serialHex: '',
        },
      }

      return transport
    })

  /**
   * Gets or creates the Cardano app instance, lazily initializing it on first use.
   * Validates app version and device serial against config.
   */
  const getCardanoApp = (): Effect.Effect<CardanoApp, HardwareErrorType> =>
    Effect.gen(function* () {
      // Return cached app if available
      if (cardanoApp) return cardanoApp

      // Ensure transport exists
      const transport = yield* getTransport()

      // Create Cardano app instance
      const app = createCardanoApp(transport)

      // Verify app version
      const versionResult = yield* Effect.tryPromise({
        try: () => app.getVersion(),
        catch: (error) => mapLedgerError(error, 'getVersion'),
      })

      const versionError = validateAppVersion(versionResult.version, config.minAppVersion ?? MIN_LEDGER_CARDANO_VERSION)
      if (versionError) {
        yield* Effect.tryPromise({
          try: () => transport.close(),
          catch: () => new HardwareError({message: 'Failed to close transport'}),
        })
        state = {connected: false}
        return yield* Effect.fail(versionError)
      }

      // Get serial number for device verification
      const serialResult = yield* Effect.tryPromise({
        try: () => app.getSerial(),
        catch: (error) => mapLedgerError(error, 'getSerial'),
      })

      // Verify device if expected serial provided
      if (config.expectedSerial && serialResult.serialHex !== config.expectedSerial) {
        yield* Effect.tryPromise({
          try: () => transport.close(),
          catch: () => new HardwareError({message: 'Failed to close transport'}),
        })
        state = {connected: false}
        return yield* Effect.fail(
          new IncorrectDeviceError({
            expectedSerial: config.expectedSerial,
            actualSerial: serialResult.serialHex,
          }),
        )
      }

      // Update state with Cardano-specific info
      if (state.deviceInfo && state.features) {
        state = {
          ...state,
          deviceInfo: {
            ...state.deviceInfo,
            deviceId: serialResult.serialHex,
            firmwareVersion: versionResult.version,
          },
          features: {
            ...(state.features as LedgerDeviceFeatures),
            deviceId: serialResult.serialHex,
            firmwareVersion: versionResult.version,
            serialHex: serialResult.serialHex,
          },
          currentApp: 'Cardano ADA',
        }
      }

      cardanoApp = app
      return app
    })

  /**
   * Closes the current connection.
   */
  const closeConnection = (): Effect.Effect<void, HardwareError> =>
    Effect.gen(function* () {
      const transport = state.transport
      if (transport) {
        yield* Effect.tryPromise({
          try: () => transport.close(),
          catch: (error) =>
            new HardwareError({
              message: 'Failed to close transport',
              cause: error,
            }),
        })
      }
      state = {connected: false}
      cardanoApp = null
    })

  const device: HardwareDevice = {
    getInfo: () =>
      Effect.gen(function* () {
        if (!state.connected || !state.deviceInfo) {
          return yield* Effect.fail(
            new DeviceNotConnectedError({
              deviceType: 'ledger',
              message: 'Device not connected',
            }),
          )
        }
        return state.deviceInfo
      }),

    getFeatures: () =>
      Effect.gen(function* () {
        if (!state.connected || !state.features) {
          return yield* Effect.fail(
            new DeviceNotConnectedError({
              deviceType: 'ledger',
              message: 'Device not connected',
            }),
          )
        }
        return state.features as DeviceFeatures
      }),

    connect: () =>
      pipe(
        getTransport(config.transport),
        Effect.map(() => undefined),
        Effect.mapError((e) => (e instanceof TransportError ? e : new HardwareError({message: e.message, cause: e}))),
      ),

    disconnect: () => closeConnection(),

    isConnected: () => state.connected,

    getLedgerModel: () => state.features?.model ?? null,

    /**
     * Round-trip a BOLOS `getAppAndVersion` APDU (`0xB0 0x01 0x00 0x00`).
     * Catches stuck transports — cable still plugged but device asleep,
     * Cardano app crashed, or stale BLE bridge session — where
     * `isConnected()` would still report true. No on-device prompt; works
     * whether the dashboard or a chain app is running.
     */
    pingDevice: () =>
      Effect.gen(function* () {
        const transport = yield* pipe(
          getTransport(),
          Effect.mapError((e) =>
            e instanceof DeviceNotConnectedError ? e : new HardwareError({message: e.message, cause: e}),
          ),
        )
        yield* boundProbe(
          Effect.tryPromise({
            try: () => transport.send(0xb0, 0x01, 0x00, 0x00),
            catch: (error) => mapLedgerOsCommandError(error, 'pingDevice'),
          }),
          'pingDevice',
        )
      }),

    getAppVersion: () =>
      Effect.gen(function* () {
        const app = yield* pipe(
          getCardanoApp(),
          Effect.mapError((e) => (e instanceof DeviceNotConnectedError ? e : new HardwareError({message: e.message}))),
        )

        const result = yield* Effect.tryPromise({
          try: () => app.getVersion(),
          catch: (error) => mapLedgerError(error, 'getAppVersion'),
        })

        const parsed = parseVersion(result.version)
        return {
          name: 'Cardano',
          version: result.version,
          major: parsed?.major ?? 0,
          minor: parsed?.minor ?? 0,
          patch: parsed?.patch ?? 0,
        } satisfies AppVersion
      }),

    getExtendedPublicKey: (derivationPath: string) =>
      Effect.gen(function* () {
        const app = yield* pipe(
          getCardanoApp(),
          Effect.mapError((e) =>
            e instanceof DeviceNotConnectedError ? e : new HardwareError({message: e.message, cause: e}),
          ),
        )
        const path = parseDerivationPath(derivationPath)

        const result = yield* Effect.tryPromise({
          try: () => app.getExtendedPublicKey({path}),
          catch: (error) => mapLedgerError(error, 'getExtendedPublicKey'),
        })

        return {
          publicKey: hexToBytes(result.publicKeyHex),
          chainCode: hexToBytes(result.chainCodeHex),
          derivationPath,
        } satisfies ExtendedPublicKey
      }),

    getExtendedPublicKeys: (derivationPaths: readonly string[]) =>
      Effect.gen(function* () {
        if (derivationPaths.length === 0) return [] as readonly ExtendedPublicKey[]

        // Detect coin type from the first path's second segment: m/purpose'/coinType'/...
        const firstPath = derivationPaths[0] ?? ''
        const coinType = Number.parseInt(firstPath.replace(/'/g, '').split('/')[2] ?? '0', 10)

        // Cardano (coin type 1815): use the Cardano app batch API
        if (coinType === 1815) {
          const app = yield* pipe(
            getCardanoApp(),
            Effect.mapError((e) =>
              e instanceof DeviceNotConnectedError ? e : new HardwareError({message: e.message, cause: e}),
            ),
          )
          const paths = derivationPaths.map(parseDerivationPath)

          const results = yield* Effect.tryPromise({
            try: () => app.getExtendedPublicKeys({paths}),
            catch: (error) => mapLedgerError(error, 'getExtendedPublicKeys'),
          })

          return results.map((result, i) => ({
            publicKey: hexToBytes(result.publicKeyHex),
            chainCode: hexToBytes(result.chainCodeHex),
            derivationPath: derivationPaths[i] ?? '',
          })) satisfies readonly ExtendedPublicKey[]
        }

        // Non-Cardano chains: use the chain-specific Ledger app
        const transport = yield* getTransport()
        const results: ExtendedPublicKey[] = []

        switch (coinType) {
          case 501: {
            // Solana — Ed25519, no chain code concept
            const solApp = createSolanaLedgerApp(transport)
            for (const path of derivationPaths) {
              const addr = yield* solApp.getAddress(path)
              results.push({
                publicKey: addr.publicKey,
                chainCode: new Uint8Array(32),
                derivationPath: path,
                address: addr.address,
              })
            }
            break
          }

          case 60: {
            // Ethereum / EVM chains — getAddress returns 65-byte uncompressed key, compress to 33.
            // Validate the decoded byte length and 0x04 prefix before calling
            // compressSecp256k1PublicKey: a stale transport buffer (e.g. residual bytes
            // after a 0x6a87) can yield a truncated response where the first byte parses
            // as publicKeyLength = 1. Surface that as a typed HardwareError so
            // `getAccounts` recovery can retry instead of bubbling the raw secp256k1
            // length assertion to the user.
            const ethApp = createEthereumLedgerApp(transport)
            for (const path of derivationPaths) {
              const addr = yield* ethApp.getAddress(path, false, true)
              const pkBytes = hexToBytes(addr.publicKey)
              if (pkBytes.length !== 65 || pkBytes[0] !== 0x04) {
                return yield* Effect.fail(
                  new HardwareError({
                    message:
                      'Ledger returned a malformed Ethereum public key. Keep the Ethereum app open and try again.',
                    expectedApp: 'Ethereum',
                    // Tag with 0x6a87 so isStaleSessionError → resolveLedgerAppRecoveryStrategy
                    // returns 'force-reopen' and getAccounts auto-retries after closing/reopening
                    // the ETH app to flush the residual transport buffer.
                    statusCode: '0x6a87',
                    cause: {publicKeyByteLength: pkBytes.length, firstByte: pkBytes[0], derivationPath: path},
                  }),
                )
              }
              results.push({
                publicKey: compressSecp256k1PublicKey(pkBytes),
                chainCode: addr.chainCode ? hexToBytes(addr.chainCode) : new Uint8Array(32),
                derivationPath: path,
              })
            }
            break
          }

          case 0: // Bitcoin
          case 2: // Litecoin
          case 3: // Dogecoin
          case 145: {
            // Bitcoin Cash — UTXO chains, compress in case device returns uncompressed key
            const btcApp = createBitcoinLedgerApp(transport)
            for (const path of derivationPaths) {
              const xpub = yield* btcApp.getExtendedPublicKey(path)
              results.push({
                publicKey: compressSecp256k1PublicKey(hexToBytes(xpub.publicKey)),
                chainCode: hexToBytes(xpub.chainCode),
                derivationPath: path,
              })
            }
            break
          }

          case 195: {
            // Tron — account-based chain, one address per account (like ETH).
            // Use address-level paths and device-returned address directly.
            const tronApp = createTronLedgerApp(transport)
            for (const path of derivationPaths) {
              const addr = yield* tronApp.getAddress(path)
              results.push({
                publicKey: compressSecp256k1PublicKey(hexToBytes(addr.publicKey)),
                chainCode: new Uint8Array(32),
                derivationPath: path,
                address: addr.address,
              })
            }
            break
          }

          default:
            return yield* Effect.fail(
              new HardwareError({message: `Unsupported coin type ${coinType} in derivation path: ${firstPath}`}),
            )
        }

        return results satisfies readonly ExtendedPublicKey[]
      }),

    signCardanoTransaction: (request: CardanoSigningRequest) =>
      Effect.gen(function* () {
        const app = yield* pipe(
          getCardanoApp(),
          Effect.mapError((e) =>
            e instanceof DeviceNotConnectedError ? e : new HardwareError({message: e.message, cause: e}),
          ),
        )

        // Resolve public keys BEFORE building the sign request — the converter
        // needs them to distinguish own vs foreign credentials and pick the right signing mode.
        const pubKeyByPath = new Map<string, string>()
        const resolvedPublicKeys: Record<string, string> = {...(request.publicKeys ?? {})}
        if (request.publicKeys) {
          const signingPathArrays = request.signingPaths.map(parseDerivationPath)
          for (let i = 0; i < request.signingPaths.length; i++) {
            const pathStr = request.signingPaths[i]
            const pathArray = signingPathArrays[i]
            if (pathStr && pathArray) {
              const hex = request.publicKeys[pathStr]
              if (hex) pubKeyByPath.set(pathArray.join('/'), hex)
            }
          }
        } else {
          const signingPathArrays = request.signingPaths.map(parseDerivationPath)
          const fetchedKeys = yield* Effect.tryPromise({
            try: () => app.getExtendedPublicKeys({paths: signingPathArrays}),
            catch: (error) => mapLedgerError(error, 'getExtendedPublicKeys'),
          })
          for (let i = 0; i < signingPathArrays.length; i++) {
            const path = signingPathArrays[i]
            const pathStr = request.signingPaths[i]
            const key = fetchedKeys[i]
            if (path && key) {
              pubKeyByPath.set(path.join('/'), key.publicKeyHex)
              if (pathStr) resolvedPublicKeys[pathStr] = key.publicKeyHex
            }
          }
        }

        // Build Ledger sign request with public keys so the converter can resolve own/foreign credentials
        const hasResolvedKeys = Object.keys(resolvedPublicKeys).length > 0
        const ledgerRequest: LedgerSignTxRequest = yield* buildLedgerSignRequest(
          hasResolvedKeys ? {...request, publicKeys: resolvedPublicKeys} : request,
        )

        const result = yield* Effect.tryPromise({
          try: () => app.signTransaction(ledgerRequest),
          catch: (error) => mapLedgerError(error, 'signTransaction'),
        })

        // Build witnesses using resolved public keys — no post-sign device calls.
        // publicKeyHashHex = blake2b-224(publicKey); it's the dedup key for the witness dict
        // downstream, so leaving it empty collapses multi-signature results into one entry.
        const witnesses: TransactionWitness[] = result.witnesses.map((w, i) => {
          const publicKeyHex = pubKeyByPath.get(w.path.join('/')) ?? ''
          const publicKeyHashHex = publicKeyHex ? bytesToHex(blake2b(hexToBytes(publicKeyHex), {dkLen: 28})) : ''
          return {
            publicKeyHashHex,
            signatureHex: w.witnessSignatureHex,
            publicKeyHex,
            // Attach CIP-36 supplement to the first witness
            ...(i === 0 && result.auxiliaryDataSupplement
              ? {
                  auxiliaryDataSupplement: {
                    auxiliaryDataHashHex: result.auxiliaryDataSupplement.auxiliaryDataHashHex,
                    cip36VoteRegistrationSignatureHex: result.auxiliaryDataSupplement.cip36VoteRegistrationSignatureHex,
                  },
                }
              : {}),
          }
        })

        return witnesses
      }),

    signMessage: (request: MessageSigningRequest) =>
      Effect.gen(function* () {
        const app = yield* pipe(
          getCardanoApp(),
          Effect.mapError((e) =>
            e instanceof DeviceNotConnectedError ? e : new HardwareError({message: e.message, cause: e}),
          ),
        )
        const path = parseDerivationPath(request.signingPath)

        const baseRequest = {
          messageHex: request.payloadHex,
          signingPath: path,
          hashPayload: request.hashPayload,
          preferHexDisplay: request.preferHexDisplay,
        } as const

        let ledgerRequest: LedgerSignMessageRequest
        if (request.addressFieldType === 'address' && request.addressParams) {
          const networkId = request.networkId ?? 1
          const protocolMagic = request.protocolMagic ?? (networkId === 1 ? 764824073 : 1)
          ledgerRequest = {
            ...baseRequest,
            addressFieldType: 'address',
            address: toLedgerDeviceOwnedAddress(request.addressParams),
            network: {networkId, protocolMagic},
          }
        } else {
          // KEY_HASH mode: firmware builds the Sig_structure address as
          // blake2b-224(signingPublicKey).
          ledgerRequest = {...baseRequest, addressFieldType: 'key_hash'}
        }

        const result = yield* Effect.tryPromise({
          try: () => app.signMessage(ledgerRequest),
          catch: (error) => mapLedgerError(error, 'signMessage'),
        })

        return {
          signature: hexToBytes(result.signatureHex),
          publicKey: hexToBytes(result.signingPublicKeyHex),
          derivationPath: request.signingPath,
        } satisfies HardwareSignature
      }),

    verifyAddress: (_address: string, derivationPath: string) =>
      Effect.gen(function* () {
        const app = yield* pipe(
          getCardanoApp(),
          Effect.mapError((e) =>
            e instanceof DeviceNotConnectedError ? e : new HardwareError({message: e.message, cause: e}),
          ),
        )
        const path = parseDerivationPath(derivationPath)

        yield* Effect.tryPromise({
          try: () =>
            app.showAddress({
              network: {networkId: 1, protocolMagic: 764824073},
              address: {
                type: AddressType.BASE_PAYMENT_KEY_STAKE_KEY,
                params: {
                  spendingPath: path,
                  stakingPath: [...path.slice(0, 3), 2, 0],
                },
              },
            }),
          catch: (error) => mapLedgerError(error, 'verifyAddress'),
        })

        return true
      }),

    getRunningAppName: () =>
      Effect.gen(function* () {
        const transport = yield* pipe(
          getTransport(),
          Effect.mapError((e) =>
            e instanceof DeviceNotConnectedError ? e : new HardwareError({message: e.message, cause: e}),
          ),
        )

        // BOLOS "get app and version" APDU — works regardless of the running app.
        // Response format: 01 <name-length> <name-bytes> <version-length> <version-bytes> ...
        const response = yield* boundProbe(
          Effect.tryPromise({
            try: () => transport.send(0xb0, 0x01, 0x00, 0x00),
            catch: (error) => mapLedgerOsCommandError(error, 'getRunningAppName'),
          }),
          'getRunningAppName',
        )

        // Parse: skip format byte (0x01), then read name length + name
        if (response.length < 4) {
          return yield* Effect.fail(new HardwareError({message: 'Invalid getAppAndVersion response'}))
        }
        const nameLen = response[1] ?? 0
        const name = Buffer.from(response.slice(2, 2 + nameLen)).toString('ascii')
        return name
      }),

    quitApp: () =>
      Effect.gen(function* () {
        if (!state.connected || !state.transport) {
          // No transport — nothing to quit. Not an error: caller may already
          // be tearing down a disconnected session.
          return
        }
        const transport = state.transport
        const isBLE = state.transportType === 'bluetooth'

        // Invalidate connection state before the APDU — the GATT will drop as
        // a side effect of quit-app on BLE, and we want isConnected() to
        // reflect that immediately so any concurrent ensureConnected does not
        // reuse the dying transport.
        if (isBLE) {
          state = {
            connected: false,
            ...(state.features !== undefined && {features: state.features}),
            ...(state.deviceInfo !== undefined && {deviceInfo: state.deviceInfo}),
          }
          cardanoApp = null

          yield* sendBleFireAndForget(
            transport,
            Effect.tryPromise({
              try: () => transport.send(0xb0, 0xa7, 0x00, 0x00),
              catch: (error) => mapLedgerOsCommandError(error, 'quitApp'),
            }),
            'quitApp',
          )
        } else {
          yield* Effect.tryPromise({
            try: () => transport.send(0xb0, 0xa7, 0x00, 0x00),
            catch: (error) => mapLedgerOsCommandError(error, 'quitApp'),
          }).pipe(
            Effect.catchAll((e) => {
              logger.warn('quitApp failed; the device may still be in the app', {
                origin: 'LedgerDevice',
                error: String(e),
              })
              return Effect.void
            }),
          )
          const {currentApp: _droppedApp, ...rest} = state
          state = rest
          cardanoApp = null
        }
      }),

    openApp: (appName: string) =>
      Effect.gen(function* () {
        let transport = yield* pipe(
          getTransport(config.transport),
          Effect.mapError((e) =>
            e instanceof DeviceNotConnectedError ? e : new HardwareError({message: e.message, cause: e}),
          ),
        )

        // Always probe the device via BOLOS APDU instead of trusting cached state.
        // Cached state can become stale after device lock/unlock cycles — the device
        // returns to the dashboard but the cache still says the app is running.
        const runningApp = yield* boundProbe(
          Effect.tryPromise({
            try: () => transport.send(0xb0, 0x01, 0x00, 0x00),
            catch: (error) => mapLedgerOsCommandError(error, 'getRunningAppName'),
          }),
          'getRunningAppName',
        ).pipe(
          Effect.map((resp) => {
            if (resp.length < 4) return null
            const nameLen = resp[1] ?? 0
            return Buffer.from(resp.slice(2, 2 + nameLen)).toString('ascii')
          }),
          Effect.catchAll((e) => {
            logger.warn('Could not read the running app name; assuming none is open', {
              origin: 'LedgerDevice',
              error: String(e),
            })
            return Effect.succeed(null)
          }),
        )

        // If the requested app is already running, just update cached state and return
        if (runningApp === appName) {
          state = {...state, currentApp: appName}
          return
        }

        const isBLE = state.transportType === 'bluetooth'
        // A Nano S re-enumerates its USB interface on every app transition —
        // including close-app (dashboard exposes different descriptors than an
        // app) — so the handle dies mid-switch just like on BLE. Other USB
        // models keep the handle, so only the Nano S needs the BLE-style
        // close → refresh → open dance below.
        const reEnumeratesOnUsbSwitch = !isBLE && (state.features?.model ?? null) === 'nanoS'

        // Invalidate cached app-specific instances (e.g. Cardano app handle)
        cardanoApp = null

        // Close the current app first (return to dashboard) for a clean switch.
        // The quit-app APDU (0xb0 0xa7) exits whichever app is running.
        // Always attempt this even when the probe failed (runningApp === null), because
        // an app may still be running — the probe can fail if the app intercepts the
        // BOLOS APDU. Sending close-app on the dashboard is harmless (error is caught).
        //
        // We tried skipping this step on BLE (relying on BOLOS to auto-close when
        // openApp is invoked with a different target) but real firmware returns 0x6e02
        // (BAD_CLA) for the still-running chain app instead of switching — observed on
        // both Nano X and Flex during Cardano → Ethereum import. Explicit close stays.
        if (runningApp !== 'BOLOS') {
          if (isBLE) {
            // On BLE: invalidate connection state before the APDU — the GATT can drop
            // mid-APDU, causing the send to throw before we get a chance to update state.
            // Preserve `features` / `deviceInfo` so model-aware lookups (e.g. the
            // settle-delay below + the service's post-openApp pre-reconnect timing)
            // still see the device model after the wipe.
            state = {
              connected: false,
              ...(state.features !== undefined && {features: state.features}),
              ...(state.deviceInfo !== undefined && {deviceInfo: state.deviceInfo}),
            }

            yield* sendBleFireAndForget(
              transport,
              Effect.tryPromise({
                try: () => transport.send(0xb0, 0xa7, 0x00, 0x00),
                catch: (error) => mapLedgerOsCommandError(error, 'closeApp'),
              }),
              'closeApp',
            )
          } else {
            // On USB Nano S: close-app re-enumerates, so the handle dies here.
            // Invalidate it (preserving model/deviceInfo for the lookups below)
            // so the refresh after the settle reopens the device — otherwise the
            // openApp APDU lands on a dead handle and is lost, leaving the device
            // on the dashboard waiting for a manual app-open.
            if (reEnumeratesOnUsbSwitch) {
              state = {
                connected: false,
                ...(state.features !== undefined && {features: state.features}),
                ...(state.deviceInfo !== undefined && {deviceInfo: state.deviceInfo}),
              }
              // The re-enum can also eat the close-app reply: WebHID neither
              // resolves nor rejects a send on a dead handle, so a plain await
              // here can hang forever. Same race as open-app below.
              yield* sendFireAndForget(
                transport,
                Effect.tryPromise({
                  try: () => transport.send(0xb0, 0xa7, 0x00, 0x00),
                  catch: (error) => mapLedgerOsCommandError(error, 'closeApp'),
                }),
                'closeApp',
                'usb',
                USB_CLOSE_APP_FIRE_AND_FORGET_SAFETY_NET_MS,
              )
            } else {
              yield* Effect.tryPromise({
                try: () => transport.send(0xb0, 0xa7, 0x00, 0x00),
                catch: (error) => mapLedgerOsCommandError(error, 'closeApp'),
              }).pipe(
                Effect.catchAll((e) => {
                  logger.warn('closeApp failed; the device may not be on the dashboard', {
                    origin: 'LedgerDevice',
                    error: String(e),
                  })
                  return Effect.void
                }),
              )
            }
          }

          // Brief delay for the device to settle on the dashboard.
          // Nano X (older SoC) needs materially longer than Stax/Flex/Gen 5 —
          // see `ble-timings.ts` for the per-model table.
          const settleMs = isBLE ? getBleSwitchTimings(state.features?.model ?? null).settleMs : 500
          yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, settleMs)))

          // closeApp reboots the transport (BLE chip reboot / USB re-enumeration).
          // The handle used for closeApp is now dead — sending openApp on it would
          // be silently dropped (BLE) or stall forever (USB), leaving the device on
          // the dashboard and failing the caller's verify step. Refresh now that
          // the device is back. `state.connected` was set false above, so
          // `getTransport` opens a fresh handle (gesture-free via getDevices+open).
          if (isBLE || reEnumeratesOnUsbSwitch) {
            transport = yield* pipe(
              getTransport(config.transport),
              Effect.mapError((e) =>
                e instanceof DeviceNotConnectedError ? e : new HardwareError({message: e.message, cause: e}),
              ),
            )
          }
        }

        if (isBLE) {
          // On BLE: send the openApp APDU but stop awaiting it as soon as the
          // GATT drops (the Ledger restarts its BLE stack on app switch).
          // iOS @ledgerhq/react-native-hw-transport-ble does NOT reject the
          // pending send Promise when the connection dies, so a plain await
          // would hang the openApp Effect forever. The race + safety-net
          // timeout below guarantees forward progress; the service layer
          // reconnects via ensureConnected() and verifies the running app
          // via a BOLOS probe afterwards. Errors are swallowed because BLE
          // drop is the expected outcome; a real failure (wrong app, user
          // rejection) is surfaced by the verify step on the way out.
          yield* sendBleFireAndForget(
            transport,
            Effect.tryPromise({
              try: () => transport.send(0xe0, 0xd8, 0x00, 0x00, Buffer.from(appName, 'ascii')),
              catch: (error) => mapLedgerOpenAppError(error, appName),
            }),
            `openApp(${appName})`,
          )
        } else if (reEnumeratesOnUsbSwitch) {
          // Nano S USB: open-app can block on an on-device user confirmation,
          // after which the device re-enumerates and the handle dies — the send
          // never resolves on the dead handle (WebHID does not reject it). Race
          // the send against the transport 'disconnect' (the re-enum signal).
          // Do NOT force connected=false here: if the handle survives (the send
          // resolved before any re-enum, e.g. opening from the dashboard) we keep
          // using it; if it re-enumerates, the transport's own 'disconnect'
          // listener flips connected=false and the service reconnects +
          // BOLOS-verifies. Forcing it false unconditionally made a live handle
          // get reopened → "The device is already open."
          //
          // Unlike BLE this is NOT fire-and-forget: a denial (0x5501) must
          // surface as UserRejectedError, and an expired confirmation window
          // must fail — the dialog is still up on the device and the abandoned
          // send keeps holding the transport's exchange lock, so pretending
          // success leaves the whole flow wedged on a poisoned handle.
          const confirmTimeoutMs = config.openAppConfirmTimeoutMs ?? USB_OPEN_APP_CONFIRM_TIMEOUT_MS
          yield* pipe(
            Effect.raceFirst(
              Effect.tryPromise({
                try: () => transport.send(0xe0, 0xd8, 0x00, 0x00, Buffer.from(appName, 'ascii')),
                catch: (error) => mapLedgerOpenAppError(error, appName),
              }),
              awaitTransportDisconnect(transport).pipe(Effect.as(new Uint8Array())),
            ),
            Effect.timeoutFail({
              duration: Duration.millis(confirmTimeoutMs),
              onTimeout: () => new DeviceTimeoutError({operation: `openApp(${appName})`, timeoutMs: confirmTimeoutMs}),
            }),
          )
        } else {
          // Other USB models keep the HID handle across the switch. Await the
          // send — it can legitimately wait on an on-device user confirmation, so
          // no short timeout — then let the app initialize and keep the connection.
          yield* Effect.tryPromise({
            try: () => transport.send(0xe0, 0xd8, 0x00, 0x00, Buffer.from(appName, 'ascii')),
            catch: (error) => mapLedgerOpenAppError(error, appName),
          })

          // Wait for the new app to initialize on the device
          yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 1000)))

          // Clear stale transport-level app API lock from previous app sessions.
          // The @ledgerhq/hw-transport decorateAppAPIMethods stores _appAPIlock on the
          // transport object. If a previous app wrapper (e.g., Cardano) set it and the
          // app switch interrupted cleanup, the lock could remain set. Clearing it
          // ensures the next app wrapper (e.g., Bitcoin) starts with a clean transport.
          const transportAny = transport as unknown as {_appAPIlock?: string | null}
          if (transportAny._appAPIlock) {
            transportAny._appAPIlock = null
          }

          // Keep the connection alive — update state with the new app name
          state = {...state, connected: true, currentApp: appName}
        }
      }),

    getChainApp: (chain: ChainAppType) =>
      Effect.gen(function* () {
        const t = yield* pipe(
          getTransport(),
          Effect.mapError((e) =>
            e instanceof DeviceNotConnectedError ? e : new HardwareError({message: e.message, cause: e}),
          ),
        )

        const chainAppFactories: Record<ChainAppType, () => unknown> = {
          cardano: () => ({
            getExtendedPublicKey: (path: string) =>
              Effect.gen(function* () {
                const result = yield* device.getExtendedPublicKey(path)
                const toHex = (bytes: Uint8Array) =>
                  Array.from(bytes)
                    .map((b) => b.toString(16).padStart(2, '0'))
                    .join('')
                return {publicKey: toHex(result.publicKey), chainCode: toHex(result.chainCode)}
              }),
            signTransaction: (request: CardanoSigningRequest) => device.signCardanoTransaction(request),
            signMessage: (request: MessageSigningRequest) => device.signMessage(request),
            verifyAddress: (address: string, derivationPath: string) => device.verifyAddress(address, derivationPath),
          }),
          bitcoin: () => createBitcoinLedgerApp(t),
          litecoin: () => createLitecoinLedgerApp(t),
          dogecoin: () => createDogecoinLedgerApp(t),
          'bitcoin-cash': () => createBitcoinCashLedgerApp(t),
          ethereum: () => createEthereumLedgerApp(t),
          solana: () => createSolanaLedgerApp(t),
          tron: () => createTronLedgerApp(t),
        }

        return chainAppFactories[chain]()
      }),
  }

  return device
}

/**
 * Gets the Cardano app capabilities based on version.
 */
export const getCardanoAppCapabilities = (version: AppVersion): CardanoAppCapabilities => {
  return {
    cip36: version.major >= LEDGER_CIP36_VERSION,
    cip1694: version.major >= LEDGER_CIP1694_VERSION,
    cip8: true, // All supported versions have CIP-8
    plutus: meetsMinimumVersion(version.version, '4.0.0'),
    multisig: meetsMinimumVersion(version.version, '3.0.0'),
  }
}

// ============================================================================
// Internal Cardano App Wrapper
// ============================================================================

/**
 * Internal type for Cardano app operations.
 */
type CardanoApp = {
  getVersion(): Promise<{version: string; compatibility: number}>
  getSerial(): Promise<{serialHex: string}>
  getExtendedPublicKey(request: {path: readonly number[]}): Promise<LedgerGetExtendedPublicKeyResponse>
  getExtendedPublicKeys(request: {
    paths: readonly (readonly number[])[]
  }): Promise<readonly LedgerGetExtendedPublicKeyResponse[]>
  signTransaction(request: LedgerSignTxRequest): Promise<{
    txHashHex: string
    witnesses: readonly {path: readonly number[]; witnessSignatureHex: string}[]
    auxiliaryDataSupplement?: {
      type: string
      auxiliaryDataHashHex: string
      cip36VoteRegistrationSignatureHex: string
    }
  }>
  signMessage(request: LedgerSignMessageRequest): Promise<{
    signatureHex: string
    signingPublicKeyHex: string
    addressFieldHex: string
  }>
  showAddress(request: {
    network: {networkId: number; protocolMagic: number}
    address: {
      type: number
      params: {
        spendingPath: readonly number[]
        stakingPath?: readonly number[]
      }
    }
  }): Promise<void>
}

/**
 * Type for the CardanoApp from @cardano-foundation/ledgerjs-hw-app-cardano.
 * Uses unknown for complex internal types to avoid bundling full library types.
 */
type CardanoAppLibrary = {
  getVersion(): Promise<{
    version: {major: number; minor: number; patch: number}
    compatibility: {
      isCompatible: boolean
      recommendedVersion: string | null
      supportsMary: boolean
      supportsCatalystRegistration: boolean
      supportsZeroTtl: boolean
      supportsPoolRegistrationAsOwner: boolean
      supportsPoolRegistrationAsOperator: boolean
      supportsPoolRetirement: boolean
      supportsNativeScriptHashDerivation: boolean
      supportsMultisigTransaction: boolean
      supportsMint: boolean
      supportsAlonzo: boolean
      supportsBabbage: boolean
      supportsConway: boolean
      supportsCIP36Vote: boolean
      supportsReqSignersInOrdinaryTx: boolean
      supportsCIP36: boolean
      supportsCIP1694: boolean
    }
  }>
  getSerial(): Promise<{serialHex: string}>
  getExtendedPublicKey(request: {path: readonly number[]}): Promise<{
    publicKeyHex: string
    chainCodeHex: string
  }>
  getExtendedPublicKeys(request: {paths: readonly (readonly number[])[]}): Promise<
    readonly {
      publicKeyHex: string
      chainCodeHex: string
    }[]
  >
  signTransaction(request: unknown): Promise<{
    txHashHex: string
    witnesses: readonly {path: readonly number[]; witnessSignatureHex: string}[]
    auxiliaryDataSupplement?: {
      type: string
      auxiliaryDataHashHex: string
      cip36VoteRegistrationSignatureHex: string
    }
  }>
  signMessage(request: unknown): Promise<{
    signatureHex: string
    signingPublicKeyHex: string
    addressFieldHex: string
  }>
  showAddress(request: unknown): Promise<void>
  deriveAddress(request: unknown): Promise<{addressHex: string}>
}

/**
 * Creates a CardanoApp instance from a transport.
 */
const createAdaAppInstance = (transport: unknown): CardanoAppLibrary => {
  // Handle both default and named export shapes of @cardano-foundation/ledgerjs-hw-app-cardano
  const AdaApp = (CardanoAppDefault ?? CardanoAppAda) as unknown as {new (transport: unknown): CardanoAppLibrary}
  return new AdaApp(transport)
}

/**
 * Creates a Cardano app wrapper around the transport.
 *
 * This implementation uses @cardano-foundation/ledgerjs-hw-app-cardano
 * when available, falling back to raw APDU commands for basic operations.
 */
const createCardanoApp = (transport: LedgerTransport): CardanoApp => {
  // Lazy-load the library instance
  let adaApp: CardanoAppLibrary | null = null

  // The Ada class constructor calls transport.decorateAppAPIMethods() which only exists
  // on real @ledgerhq/hw-transport instances. Custom transports (e.g. BLE bridge relay)
  // need a shim so the constructor doesn't throw.
  //
  // Additionally, @cardano-foundation/ledgerjs-hw-app-cardano checks Buffer.isBuffer()
  // on APDU responses (in stripRetcodeFromResponse, bech32_encodeAddress, etc.).
  // Custom transports may return Uint8Array instead of Buffer, so we wrap send()
  // to ensure responses are always Buffer instances.
  const wrapSendWithBuffer = (originalSend: LedgerTransport['send']): LedgerTransport['send'] => {
    return async (cla, ins, p1, p2, data) => {
      const result = await originalSend(cla, ins, p1, p2, data)
      // Return as-is if already a Buffer; otherwise convert
      return Buffer.isBuffer(result) ? result : Buffer.from(result)
    }
  }

  const compatTransport =
    'decorateAppAPIMethods' in transport
      ? Object.assign(Object.create(transport) as LedgerTransport, {
          send: wrapSendWithBuffer(transport.send.bind(transport)),
        })
      : Object.assign(Object.create(transport) as LedgerTransport, {
          send: wrapSendWithBuffer(transport.send.bind(transport)),
          decorateAppAPIMethods(_self: unknown, _methods: string[], _scrambleKey: string) {
            // No-op: custom transports handle serialization themselves
          },
        })

  const getApp = (): CardanoAppLibrary => {
    if (adaApp) return adaApp
    adaApp = createAdaAppInstance(compatTransport)
    return adaApp
  }

  return {
    async getVersion() {
      try {
        const app = getApp()
        const result = await app.getVersion()
        return {
          version: `${result.version.major}.${result.version.minor}.${result.version.patch}`,
          compatibility: result.compatibility.isCompatible ? 1 : 0,
        }
      } catch (error) {
        // Don't mask app-not-open errors with a raw APDU fallback that will also fail
        if (isAppNotOpenError(error) || isWrongAppError(error)) {
          throw error
        }

        // Fallback to raw APDU for getVersion (basic operation)
        const response = await transport.send(0xd7, 0x00, 0x00, 0x00)
        const major = response[0] ?? 0
        const minor = response[1] ?? 0
        const patch = response[2] ?? 0
        return {
          version: `${major}.${minor}.${patch}`,
          compatibility: response[3] ?? 0,
        }
      }
    },

    async getSerial() {
      try {
        const app = getApp()
        return await app.getSerial()
      } catch (e: unknown) {
        // Fallback to raw APDU. A device on an older firmware takes this path routinely, so a
        // real transport failure is otherwise indistinguishable from an old device.
        logger.debug('Ledger getSerial via app failed; falling back to a raw APDU', {
          origin: 'ledger/device',
          error: String(e),
        })
        const response = await transport.send(0xd7, 0x01, 0x00, 0x00)
        const serialHex = bytesToHex(response.subarray(0, 7))
        return {serialHex}
      }
    },

    async getExtendedPublicKey(request) {
      const app = getApp()
      return await app.getExtendedPublicKey({path: [...request.path]})
    },

    async getExtendedPublicKeys(request) {
      const app = getApp()
      return await app.getExtendedPublicKeys({paths: request.paths.map((p) => [...p])})
    },

    async signTransaction(request) {
      const app = getApp()
      return await app.signTransaction(request)
    },

    async signMessage(request) {
      const app = getApp()
      return await app.signMessage(request)
    },

    async showAddress(request) {
      const app = getApp()
      return await app.showAddress(request)
    },
  }
}

/**
 * Converts CIP-36 registration params from the generic format to Ledger's format.
 */
const convertCIP36Registration = (params: CIP36RegistrationParams): LedgerAuxiliaryData => {
  const delegations: LedgerCIP36VoteDelegation[] = Array.isArray(params.delegations)
    ? params.delegations.map((d) => ({type: CIP36VoteDelegationType.KEY, voteKeyHex: d.voteKeyHex, weight: d.weight}))
    : [
        {
          type: CIP36VoteDelegationType.KEY,
          voteKeyHex: (params.delegations as {readonly voteKeyHex: string}).voteKeyHex,
          weight: 1,
        },
      ]

  const stakingPath = parseDerivationPath(params.stakingPath)

  const paymentDestination =
    params.paymentDestination.type === 'third_party'
      ? ({type: 'third_party', params: {addressHex: params.paymentDestination.addressHex}} as const)
      : ({
          type: 'device_owned',
          params: {
            type: AddressType.BASE_PAYMENT_KEY_STAKE_KEY,
            params: {
              spendingPath: parseDerivationPath(params.paymentDestination.addressParams.spendingPath),
              stakingPath: parseDerivationPath(params.paymentDestination.addressParams.stakingPath),
            },
          },
        } as const)

  return {
    type: TxAuxiliaryDataType.CIP36_REGISTRATION,
    params: {
      format: CIP36VoteRegistrationFormat.CIP_36,
      delegations,
      stakingPath,
      paymentDestination,
      nonce: params.nonce,
      votingPurpose: params.votingPurpose ?? 0,
    },
  }
}

/**
 * Builds a Ledger sign transaction request from our format.
 *
 * Parses the CBOR transaction body and converts all components to
 * Ledger's expected format for signing.
 */
const buildLedgerSignRequest = (request: CardanoSigningRequest): Effect.Effect<LedgerSignTxRequest, HardwareError> =>
  Effect.gen(function* () {
    // Parse the CBOR transaction body
    const {body: parsedTxBody, tagCborSets} = yield* parseTransactionBody(request.txBodyHex)

    // The decision, and the reasoning for it, live in `signing-mode.ts` — pure,
    // so the table can be tested without a device.
    const signingMode = ledgerSigningModeFor({
      ...(request.multisig === undefined ? {} : {multisig: request.multisig}),
      hasWitnessHash: parsedTxBody.witnessHash !== undefined,
      hasCollateralInputs: (parsedTxBody.collateral?.inputs?.length ?? 0) > 0,
      hasRequiredSigners: (parsedTxBody.signers?.length ?? 0) > 0,
      signingPathCount: request.signingPaths.length,
    })

    // Convert CIP-36 registration params if provided
    const cip36Registration = request.cip36Registration
      ? convertCIP36Registration(request.cip36Registration)
      : undefined

    // Build the Ledger sign request from parsed transaction body.
    // convertToLedgerRequest may throw for unsupported certificates — catch and map to HardwareError.
    return yield* Effect.try({
      try: () =>
        convertToLedgerRequest(parsedTxBody, request.networkId, request.signingPaths, signingMode, {
          tagCborSets,
          ...(cip36Registration ? {cip36Registration} : {}),
          ...(request.protocolMagic !== undefined ? {protocolMagic: request.protocolMagic} : {}),
          ...(request.publicKeys ? {publicKeys: request.publicKeys} : {}),
        }),
      catch: (e) => new HardwareError({message: e instanceof Error ? e.message : String(e), cause: e}),
    })
  })
