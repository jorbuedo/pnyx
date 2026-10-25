/**
 * Trezor device implementation.
 *
 * Provides Effect-based interface for Trezor hardware wallet operations.
 * Uses our own trezor-protocol/ layer for protobuf messaging — no @trezor/connect dependency.
 *
 * @module
 */

import {buildTrezorSignRequest as convertToTrezorRequest} from '@evolution-sdk/hardware-cardano/Trezor'
import {blake2b} from '@noble/hashes/blake2.js'
import {createLogger} from '@pnyx/logger'
import {Effect} from 'effect'
import {parseTransactionBody} from '../cardano/parse-tx-body'
import type {DeviceSession, TransportAdapter} from '../trezor-protocol/device-session'
import {
  acquireSession,
  bitcoinSignTx,
  cardanoSignTx,
  ethereumSignTx,
  ethereumSignTypedData,
  initializeDevice,
  solanaSignTx,
  upgradeToV2Session,
} from '../trezor-protocol/device-session'
import {PROTOCOL_MALFORMED} from '../trezor-protocol/errors'
import {performThpHandshake} from '../trezor-protocol/thp/handshake-orchestration'
import type {
  AppVersion,
  CardanoMessageAddressParams,
  CardanoSigningRequest,
  ChainAppType,
  DeviceFeatures,
  DeviceInfo,
  ExtendedPublicKey,
  HardwareDevice,
  HardwareErrorType,
  MessageSigningRequest,
  TransactionWitness,
  TrezorConfig,
  TrezorDeviceFeatures,
  TrezorModel,
} from '../types'
import {DeviceNotConnectedError, HardwareError, TransportError} from '../types'
import {bytesToHex, HARDENED, hexToBytes, parseDerivationPath, requireDerivationPath} from '../utils'
import {
  formatTrezorConnectUnavailableInfo,
  getTrezorConnectUnavailableCapabilityInfo,
  getTrezorConnectUnavailableMethodInfo,
  getTrezorRawCapabilities,
  isTrezorConnectCapabilityUnavailable,
  isTrezorConnectMethodUnavailable,
  normalizeTrezorInternalModel,
  shouldUseLegacyBitcoinSignProcess,
} from './compatibility'
import {mapTrezorError} from './errors'
import {fetchEthereumDefinitions, fetchSolanaTokenDefinition} from './external-definitions'
import {
  createTrezorBitcoin,
  createTrezorBitcoinCash,
  createTrezorDogecoin,
  createTrezorEthereum,
  createTrezorLitecoin,
  createTrezorSolana,
} from './multichain'
import {toProtoAddressParams} from './proto-helpers'
import type {TrezorCardanoSignTxRequest, TrezorConnectionState} from './types'

/** Decode a base58-encoded string to bytes (for Solana addresses). */
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const base58Decode = (str: string): Uint8Array => {
  const bytes: number[] = []
  for (const char of str) {
    const value = BASE58_ALPHABET.indexOf(char)
    if (value === -1) throw new Error(`Invalid base58 character: ${char}`)
    let carry = value
    for (let j = 0; j < bytes.length; j++) {
      carry += (bytes[j] ?? 0) * 58
      bytes[j] = carry & 0xff
      carry >>= 8
    }
    while (carry > 0) {
      bytes.push(carry & 0xff)
      carry >>= 8
    }
  }
  // Handle leading '1's (zero bytes)
  for (const char of str) {
    if (char !== '1') break
    bytes.push(0)
  }
  return new Uint8Array(bytes.reverse())
}

// Deep path, not the package barrel: the barrel re-exports encode/decode, which
// pull in protobufjs. We only need the generated enums.
import {CardanoAddressType, CardanoDerivationType} from '@trezor/protobuf/lib/messages-schema'

/**
 * Map a chain-agnostic CIP-8 address descriptor to the Trezor
 * `CardanoAddressParametersType` wire shape for ADDRESS-mode message signing.
 * A reward address carries only `address_n_staking`; base/enterprise carry the
 * payment path in `address_n`.
 */
const toTrezorMessageAddressParams = (params: CardanoMessageAddressParams): Record<string, unknown> => {
  switch (params.type) {
    case 'reward':
      return {
        address_type: CardanoAddressType.REWARD,
        address_n_staking: requireDerivationPath(params.stakingPath, 'reward address stakingPath'),
      }
    case 'enterprise':
      return {
        address_type: CardanoAddressType.ENTERPRISE,
        address_n: requireDerivationPath(params.spendingPath, 'enterprise address spendingPath'),
      }
    default:
      return {
        address_type: CardanoAddressType.BASE,
        address_n: requireDerivationPath(params.spendingPath, 'base address spendingPath'),
        address_n_staking: requireDerivationPath(params.stakingPath, 'base address stakingPath'),
      }
  }
}

/**
 * Trezor getFeatures response (from protobuf Features message).
 */
type TrezorFeaturesResponse = {
  readonly vendor: string
  readonly major_version: number
  readonly minor_version: number
  readonly patch_version: number
  readonly bootloader_mode: boolean | null
  readonly device_id: string | null
  readonly pin_protection: boolean
  readonly passphrase_protection: boolean
  readonly language: string | null
  readonly label: string | null
  readonly initialized: boolean
  readonly revision: string | null
  readonly model: string
  readonly internal_model?: string
  readonly needs_backup: boolean
  readonly capabilities: readonly (string | number)[]
  readonly session_id: string | null
  readonly passphrase_always_on_device: boolean
}

/**
 * Maps Trezor features to our TrezorModel type.
 *
 * Prefers `internal_model` (available since firmware 2.6.0) which contains
 * the actual hardware identifier (T1B1, T2T1, T3T1, etc.), falling back to
 * the legacy `model` field which only returns "1" or "T".
 */
const mapTrezorModel = (features: TrezorFeaturesResponse): TrezorModel => {
  const internalModelMap: Record<string, TrezorModel> = {
    T1B1: 'one',
    T2T1: 'T',
    T2B1: 'safe3',
    T3B1: 'safe3',
    T3T1: 'safe5',
    T3W1: 'safe7',
  }
  const internalMatch = features.internal_model ? internalModelMap[features.internal_model] : undefined
  if (internalMatch) return internalMatch

  const legacyMap: Record<string, TrezorModel> = {
    '1': 'one',
    T: 'T',
  }
  return legacyMap[features.model] ?? 'T'
}

const createUnsupportedFirmwareResponse = (error: string) => ({
  success: false as const,
  payload: {error},
})

const createUnsupportedFirmwareFailure = (error: string) => ({
  success: false as const,
  error,
})

const isTaprootDerivationPath = (path: string): boolean => path.replace(/^m\//, '').startsWith("86'")

const getCapabilityUnavailableMessage = (
  features: TrezorDeviceFeatures | undefined,
  capability: Parameters<typeof getTrezorConnectUnavailableCapabilityInfo>[1],
  description: string,
): string => {
  const info = getTrezorConnectUnavailableCapabilityInfo(features, capability)
  return info
    ? formatTrezorConnectUnavailableInfo(info, description)
    : `${description} is not supported on this Trezor model/firmware.`
}

const getMethodUnavailableMessage = (
  features: TrezorDeviceFeatures | undefined,
  method: Parameters<typeof getTrezorConnectUnavailableMethodInfo>[1],
  description: string,
): string => {
  const info = getTrezorConnectUnavailableMethodInfo(features, method)
  return info
    ? formatTrezorConnectUnavailableInfo(info, description)
    : `${description} is not supported on this Trezor model/firmware.`
}

type TrezorDeviceReturn = HardwareDevice & {
  /**
   * Re-acquire session on the existing transport without creating a new USB connection.
   * Use when the session is stale but the USB interface is still claimed.
   * Falls back to full connect() if re-acquisition fails.
   */
  readonly reconnect: () => Effect.Effect<void, HardwareErrorType>
  /** Update UI callbacks (PIN, passphrase, button, pairing code) after initial connection. */
  readonly updateCallbacks: (callbacks: {
    onPinRequest?: TrezorConfig['onPinRequest']
    onInvalidPin?: TrezorConfig['onInvalidPin']
    onPassphraseRequest?: TrezorConfig['onPassphraseRequest']
    onButtonRequest?: TrezorConfig['onButtonRequest']
    onPairingCode?: TrezorConfig['onPairingCode']
  }) => void
}

/**
 * Creates a Trezor device instance.
 *
 * Uses the session-based API with transport adapter + device path.
 * The adapter can be a bridge transport (E2E), native USB/BLE transport,
 * or Web Bluetooth transport.
 */
export const createTrezorDevice = (
  adapter: TransportAdapter,
  devicePath: string,
  config: TrezorConfig,
): TrezorDeviceReturn => createTrezorDeviceImpl(adapter, devicePath, config)

const createTrezorDeviceImpl = (
  adapter: TransportAdapter,
  devicePath: string,
  config: TrezorConfig,
): TrezorDeviceReturn => {
  const logger = config.logger ?? createLogger()

  // Mutable config — updateCallbacks() mutates callback fields so the
  // call-loop always reads the latest closures (not stale connection-time ones).
  let mutableConfig: TrezorConfig = {...config}

  // Internal state
  let state: TrezorConnectionState = {
    initialized: false,
    connected: false,
  }

  // Active session (acquired on connect, released on disconnect)
  let session: DeviceSession | null = null
  // Track previous session ID for proper re-acquire
  let previousSessionId: string | undefined

  /**
   * Gets the device callbacks from the mutable config.
   */
  const getCallbacks = () => ({
    onPinRequest: mutableConfig.onPinRequest
      ? (type?: string) => {
          const pinTypeMap: Record<string, 'current' | 'new_first' | 'new_second'> = {
            PinMatrixRequestType_Current: 'current',
            PinMatrixRequestType_NewFirst: 'new_first',
            PinMatrixRequestType_NewSecond: 'new_second',
          }
          const mappedType = type ? pinTypeMap[type] : undefined
          // biome-ignore lint/style/noNonNullAssertion: guarded by outer conditional
          return mutableConfig.onPinRequest!(mappedType)
        }
      : undefined,
    onInvalidPin: mutableConfig.onInvalidPin,
    onPassphraseRequest: mutableConfig.onPassphraseRequest,
    onButtonRequest: mutableConfig.onButtonRequest,
  })

  /**
   * Ensures a session is active and wraps a session operation with error handling.
   */
  const withSession = <T>(
    operation: string,
    fn: (
      s: DeviceSession,
    ) => Promise<{success: true; payload: T} | {success: false; error: string; message?: string | undefined}>,
  ): Effect.Effect<T, HardwareErrorType> =>
    Effect.gen(function* () {
      if (!session) {
        return yield* Effect.fail(
          new DeviceNotConnectedError({
            deviceType: 'trezor',
            message: 'Device not connected. Call connect() first.',
          }),
        )
      }

      const activeSession = session
      const result = yield* Effect.tryPromise({
        try: () => fn(activeSession),
        catch: (error) => {
          // ⚠️ Every device operation funnels through here, and this path used to
          // fail silently: a bug report's trail showed the `cardanoSignTx` request
          // go out and then nothing at all for the 33s the device was being used,
          // so a signature that failed could not be told from one that succeeded.
          logger.warn('a Trezor operation threw', {
            origin: 'TrezorDevice',
            operation,
            error: String(error),
          })
          return mapTrezorError(error, operation)
        },
      })

      if (!result.success) {
        logger.warn('a Trezor operation was refused', {
          origin: 'TrezorDevice',
          operation,
          code: result.error,
          reason: result.message ?? result.error,
        })
        return yield* Effect.fail(mapTrezorError(new Error(result.message ?? result.error), operation, result.error))
      }

      return result.payload
    })

  /**
   * Routes a single extended public key request to the correct Trezor protobuf message
   * based on coin type in the derivation path.
   */
  const getPublicKeyFromSession = async (
    s: DeviceSession,
    derivationPath: string,
  ): Promise<
    {success: true; payload: ExtendedPublicKey} | {success: false; error: string; message?: string | undefined}
  > => {
    const pathNums = parseDerivationPath(derivationPath)
    const coinType = pathNums[1] ?? 0

    // Route to the correct protobuf message based on the coin type
    // encoded in the BIP-44 derivation path (second component).
    if (coinType === 1815 + HARDENED) {
      if (isTrezorConnectMethodUnavailable(state.features, 'cardanoGetPublicKey')) {
        return createUnsupportedFirmwareFailure(
          getMethodUnavailableMessage(state.features, 'cardanoGetPublicKey', 'Cardano public key export'),
        )
      }

      // Cardano (CIP-1852): m/1852'/1815'/...
      const result = await s.typedCall('CardanoGetPublicKey', 'CardanoPublicKey', {
        address_n: pathNums,
        show_display: false,
        derivation_type: CardanoDerivationType.ICARUS_TREZOR,
      })
      if (!result.success) return result

      const node = result.payload.message.node as {public_key: string; chain_code: string}
      return {
        success: true as const,
        payload: {
          publicKey: hexToBytes(node.public_key),
          chainCode: hexToBytes(node.chain_code),
          derivationPath,
        } satisfies ExtendedPublicKey,
      }
    }

    if (coinType === 60 + HARDENED) {
      // Ethereum (BIP-44): m/44'/60'/...
      const result = await s.typedCall('EthereumGetPublicKey', 'EthereumPublicKey', {
        address_n: pathNums,
        show_display: false,
      })
      if (!result.success) return result

      const node = result.payload.message.node as {public_key: string; chain_code: string}
      return {
        success: true as const,
        payload: {
          publicKey: hexToBytes(node.public_key),
          chainCode: hexToBytes(node.chain_code),
          derivationPath,
        } satisfies ExtendedPublicKey,
      }
    }

    if (coinType === 501 + HARDENED) {
      if (isTrezorConnectMethodUnavailable(state.features, 'solanaGetPublicKey')) {
        return createUnsupportedFirmwareFailure(
          getMethodUnavailableMessage(state.features, 'solanaGetPublicKey', 'Solana public key export'),
        )
      }

      // Solana (SLIP-44): m/44'/501'/...
      // Solana addresses are base58-encoded Ed25519 public keys — no chain code,
      // no HDNode. Solana derives to terminal leaf nodes; no further HD derivation
      // is needed at the application level. Uses SolanaGetAddress (matching
      // upstream trezor-suite account discovery) rather than SolanaGetPublicKey.
      const result = await s.typedCall('SolanaGetAddress', 'SolanaAddress', {
        address_n: pathNums,
        show_display: false,
      })
      if (!result.success) return result

      const address = result.payload.message.address as string
      return {
        success: true as const,
        payload: {
          publicKey: base58Decode(address),
          chainCode: new Uint8Array(32),
          derivationPath,
        } satisfies ExtendedPublicKey,
      }
    }

    // Bitcoin-family chains (BIP-44/49/84/86): m/purpose'/coinType'/...
    // Covers Bitcoin (0'), Litecoin (2'), Dogecoin (3'), BCH (145'), etc.
    if (isTaprootDerivationPath(derivationPath) && isTrezorConnectCapabilityUnavailable(state.features, 'taproot')) {
      return createUnsupportedFirmwareFailure(
        getCapabilityUnavailableMessage(state.features, 'taproot', 'Taproot account export'),
      )
    }
    const result = await s.typedCall('GetPublicKey', 'PublicKey', {
      address_n: pathNums,
      show_display: false,
    })
    if (!result.success) return result

    const node = result.payload.message.node as {public_key: string; chain_code: string}
    return {
      success: true as const,
      payload: {
        publicKey: hexToBytes(node.public_key),
        chainCode: hexToBytes(node.chain_code),
        derivationPath,
      } satisfies ExtendedPublicKey,
    }
  }

  const device: HardwareDevice = {
    getInfo: () =>
      Effect.gen(function* () {
        if (!state.connected || !state.features) {
          return yield* Effect.fail(
            new DeviceNotConnectedError({
              deviceType: 'trezor',
              message: 'Device not connected',
            }),
          )
        }

        const info: DeviceInfo = {
          type: 'trezor',
          model: state.features.model,
          deviceId: state.features.deviceId,
          firmwareVersion: state.features.firmwareVersion,
          status: 'connected',
          transportType: 'webusb',
        }
        if (state.features.label) {
          ;(info as {label?: string}).label = state.features.label
        }

        return info
      }),

    getFeatures: () =>
      Effect.gen(function* () {
        if (!state.connected || !state.features) {
          return yield* Effect.fail(
            new DeviceNotConnectedError({
              deviceType: 'trezor',
              message: 'Device not connected',
            }),
          )
        }
        return state.features as DeviceFeatures
      }),

    connect: () =>
      Effect.gen(function* () {
        // Acquire a session on the transport adapter
        logger.debug('Acquiring session...', {origin: 'TrezorDevice'})
        const sessionResult = yield* Effect.tryPromise({
          try: () =>
            acquireSession({
              adapter,
              path: devicePath,
              protocol: 'v1', // Start with v1, auto-detect THP later
              callbacks: getCallbacks(),
              timeout: config.timeout,
              previousSession: previousSessionId,
            }),
          catch: (error) =>
            new TransportError({
              transportType: 'webusb',
              message: `Failed to acquire session: ${error instanceof Error ? error.message : String(error)}`,
              cause: error,
            }),
        })

        if (!sessionResult.success) {
          return yield* Effect.fail(
            new TransportError({
              transportType: 'webusb',
              message: `Failed to acquire session: ${sessionResult.message ?? sessionResult.error}`,
            }),
          )
        }

        let acquiredSession = sessionResult.payload
        session = acquiredSession
        previousSessionId = acquiredSession.sessionId
        logger.debug('Session acquired', {origin: 'TrezorDevice', sessionId: acquiredSession.sessionId})

        // Initialize device and get Features
        logger.debug('Initializing device...', {origin: 'TrezorDevice'})
        const initResult = yield* Effect.tryPromise({
          try: () => initializeDevice(acquiredSession, {deriveCardano: true}),
          catch: (error) => mapTrezorError(error, 'initialize'),
        })

        if (!initResult.success) {
          // Check for THP v2 requirement (Safe 5/7 devices).
          // Over USB, the device responds with a proper Failure(InvalidProtocol) that v1 can parse.
          // Over BLE, the device responds with raw THP v2 frames that the v1 decoder can't parse,
          // resulting in PROTOCOL_MALFORMED instead.
          const isInvalidProtocol =
            initResult.error === 'Failure_InvalidProtocol' ||
            initResult.error === PROTOCOL_MALFORMED ||
            (initResult.message ?? '').includes('InvalidProtocol')

          if (isInvalidProtocol) {
            // Load previously persisted THP credentials for reconnection
            let knownCredentials:
              | Array<{trezor_static_public_key: string; credential: string; host_static_key: string}>
              | undefined
            if (mutableConfig.onThpCredentialLoad) {
              knownCredentials = yield* Effect.promise(async () => {
                try {
                  // biome-ignore lint/style/noNonNullAssertion: guarded by outer conditional
                  return await mutableConfig.onThpCredentialLoad!(devicePath)
                } catch (e) {
                  logger.warn('Failed to load THP credentials', {origin: 'TrezorDevice', cause: e})
                  return undefined
                }
              })
              if (knownCredentials?.length) {
                logger.debug('Loaded THP credentials for reconnect', {
                  origin: 'TrezorDevice',
                  count: knownCredentials.length,
                })
              }
            }

            // Device requires THP v2 — run encrypted handshake
            const handshakeResult = yield* Effect.tryPromise({
              try: () =>
                performThpHandshake(adapter, acquiredSession.sessionId, {
                  onPairingCode: mutableConfig.onPairingCode,
                  hostName: mutableConfig.hostName ?? mutableConfig.appName,
                  appName: mutableConfig.appName,
                  logger,
                  knownCredentials,
                }),
              catch: (error) => mapTrezorError(error, 'thp_handshake'),
            })

            if (!handshakeResult.success) {
              logger.error('THP handshake failed', {
                origin: 'TrezorDevice',
                error: handshakeResult.error,
                message: handshakeResult.message,
              })
              return yield* Effect.fail(
                mapTrezorError(
                  new Error(handshakeResult.message ?? handshakeResult.error),
                  'thp_handshake',
                  handshakeResult.error,
                ),
              )
            }

            logger.info('THP handshake completed successfully', {origin: 'TrezorDevice'})
            const thpState = handshakeResult.payload

            // Persist credentials for future reconnections
            if (mutableConfig.onThpCredentialStore && thpState.pairingCredentials.length > 0) {
              yield* Effect.promise(async () => {
                try {
                  // biome-ignore lint/style/noNonNullAssertion: guarded by outer conditional
                  await mutableConfig.onThpCredentialStore!(devicePath, thpState.pairingCredentials)
                  logger.debug('Stored THP credentials', {
                    origin: 'TrezorDevice',
                    count: thpState.pairingCredentials.length,
                  })
                } catch (e) {
                  logger.warn('Failed to store THP credentials', {origin: 'TrezorDevice', cause: e})
                }
              })
            }

            // Upgrade to v2 in-place — do NOT release the USB session.
            // closeDevice() calls device.reset() (USB bus reset) which causes Trezor
            // firmware to invalidate the THP session, so the subsequent Initialize
            // would fail with Failure_UnexpectedMessage. Reuse the same transport
            // session ID (and thus the same open USB connection) with v2 protocol.
            logger.debug('Upgrading session to v2 protocol...', {origin: 'TrezorDevice'})
            acquiredSession = upgradeToV2Session(adapter, acquiredSession, thpState, getCallbacks(), config.timeout)
            session = acquiredSession
            // previousSessionId intentionally unchanged: same session, same USB path

            // Get device features over the encrypted v2 channel.
            // ThpCreateNewSession already initialized the session with derive_cardano,
            // so we use GetFeatures (not Initialize which resets state and is rejected
            // by THP firmware as "Unexpected message").
            const v2InitResult = yield* Effect.tryPromise({
              try: () => acquiredSession.typedCall('GetFeatures', 'Features'),
              catch: (error) => mapTrezorError(error, 'initialize'),
            })

            if (!v2InitResult.success) {
              return yield* Effect.fail(
                mapTrezorError(new Error(v2InitResult.message ?? v2InitResult.error), 'initialize', v2InitResult.error),
              )
            }

            const v2Features = v2InitResult.payload.message as unknown as TrezorFeaturesResponse
            const v2Model = mapTrezorModel(v2Features)
            const v2InternalModel = normalizeTrezorInternalModel(v2Features.internal_model, v2Model)
            const v2RawCapabilities = getTrezorRawCapabilities(v2Features.capabilities)
            const v2DeviceFeatures: TrezorDeviceFeatures = {
              type: 'trezor',
              model: v2Model,
              deviceId: v2Features.device_id ?? '',
              firmwareVersion: `${v2Features.major_version}.${v2Features.minor_version}.${v2Features.patch_version}`,
              rawCapabilities: v2RawCapabilities,
              passphraseProtection: v2Features.passphrase_protection ?? false,
              pinProtection: v2Features.pin_protection ?? false,
              ...(v2InternalModel ? {internalModel: v2InternalModel} : {}),
            }
            if (v2Features.label) {
              ;(v2DeviceFeatures as {label?: string}).label = v2Features.label
            }

            state = {
              ...state,
              initialized: true,
              connected: true,
              features: v2DeviceFeatures,
            }
            return
          }

          return yield* Effect.fail(
            mapTrezorError(new Error(initResult.message ?? initResult.error), 'initialize', initResult.error),
          )
        }

        const features = initResult.payload.message as unknown as TrezorFeaturesResponse
        const model = mapTrezorModel(features)
        const internalModel = normalizeTrezorInternalModel(features.internal_model, model)
        const rawCapabilities = getTrezorRawCapabilities(features.capabilities)

        const deviceFeatures: TrezorDeviceFeatures = {
          type: 'trezor',
          model,
          deviceId: features.device_id ?? '',
          firmwareVersion: `${features.major_version}.${features.minor_version}.${features.patch_version}`,
          rawCapabilities,
          passphraseProtection: features.passphrase_protection ?? false,
          pinProtection: features.pin_protection ?? false,
          ...(internalModel ? {internalModel} : {}),
        }
        if (features.label) {
          ;(deviceFeatures as {label?: string}).label = features.label
        }

        // Update state with connection info and features
        state = {
          ...state,
          initialized: true,
          connected: true,
          features: deviceFeatures,
        }
      }),

    disconnect: () =>
      Effect.gen(function* () {
        if (session) {
          // Use Effect.either so a failed release (e.g. device physically unplugged) doesn't
          // abort the rest of the cleanup — state.connected must be set to false regardless.
          yield* Effect.either(
            Effect.tryPromise({
              try: () => session?.release() ?? Promise.resolve(),
              catch: () =>
                new TransportError({
                  transportType: 'webusb',
                  message: 'Failed to release session',
                }),
            }),
          )
          session = null
          previousSessionId = undefined
        }

        state = {
          initialized: state.initialized,
          connected: false,
        }
      }),

    isConnected: () => state.connected,

    /**
     * Round-trip a `Ping` protobuf to the device. Bypasses the bridge
     * daemon's `GetFeatures` cache, which keeps reporting "alive" even
     * after physical disconnect. `button_protection: false` keeps the
     * device-side display silent.
     */
    pingDevice: () =>
      withSession('ping', async (s) => s.typedCall('Ping', 'Success', {message: '', button_protection: false})).pipe(
        Effect.asVoid,
      ),

    getAppVersion: () =>
      Effect.gen(function* () {
        // Trezor doesn't have separate apps - firmware version is the relevant version
        if (!state.features) {
          return yield* Effect.fail(
            new DeviceNotConnectedError({
              deviceType: 'trezor',
              message: 'Device not connected',
            }),
          )
        }

        const version = state.features.firmwareVersion
        const parts = version.split('.')
        const major = parseInt(parts[0] ?? '0', 10)
        const minor = parseInt(parts[1] ?? '0', 10)
        const patch = parseInt(parts[2] ?? '0', 10)

        return {
          name: 'Trezor Firmware',
          version,
          major,
          minor,
          patch,
        } satisfies AppVersion
      }),

    getExtendedPublicKey: (derivationPath: string) =>
      withSession('getExtendedPublicKey', (s) => getPublicKeyFromSession(s, derivationPath)),

    getExtendedPublicKeys: (derivationPaths: readonly string[]) =>
      withSession('getExtendedPublicKeys', async (s) => {
        const results: ExtendedPublicKey[] = []
        for (const derivationPath of derivationPaths) {
          const result = await getPublicKeyFromSession(s, derivationPath)
          if (!result.success) return result
          results.push(result.payload)
        }
        return {success: true as const, payload: results}
      }),

    signCardanoTransaction: (request: CardanoSigningRequest) =>
      Effect.gen(function* () {
        if (isTrezorConnectMethodUnavailable(state.features, 'cardanoSignTransaction')) {
          return yield* Effect.fail(
            mapTrezorError(
              new Error(
                getMethodUnavailableMessage(state.features, 'cardanoSignTransaction', 'Cardano transaction signing'),
              ),
              'signTransaction',
            ),
          )
        }

        // Build Trezor sign request with parsed CBOR
        const trezorRequest = yield* buildTrezorSignRequest(request)
        logger.debug('[Trezor] cardanoSignTx request', trezorRequest)

        const result = yield* withSession('signTransaction', async (s) => {
          // Convert the TrezorCardanoSignTxRequest to CardanoSignTxParams
          const signResult = await cardanoSignTx(s, {
            signingMode: trezorRequest.signingMode,
            protocolMagic: trezorRequest.protocolMagic,
            networkId: trezorRequest.networkId,
            fee: trezorRequest.fee,
            ...(trezorRequest.ttl !== undefined ? {ttl: trezorRequest.ttl} : {}),
            ...(trezorRequest.validityIntervalStart !== undefined
              ? {validityIntervalStart: trezorRequest.validityIntervalStart}
              : {}),
            inputs: trezorRequest.inputs.map((i) => ({
              prev_hash: i.prev_hash,
              prev_index: i.prev_index,
              ...(i.path ? {path: i.path} : {}),
            })),
            outputs: trezorRequest.outputs.map((o) => ({
              ...(o.address ? {address: o.address} : {}),
              ...(o.addressParameters ? {address_parameters: toProtoAddressParams(o.addressParameters)} : {}),
              amount: o.amount,
              ...(o.tokenBundle ? {tokenBundle: o.tokenBundle} : {}),
              ...(o.datumHash ? {datum_hash: o.datumHash} : {}),
              ...(o.inlineDatum ? {inlineDatum: o.inlineDatum} : {}),
              ...(o.referenceScript ? {referenceScript: o.referenceScript} : {}),
              ...(o.format != null ? {format: o.format} : {}),
            })),
            certificates: trezorRequest.certificates?.map((c) => ({
              type: c.type,
              ...(c.path ? {path: fromTrezorPath(c.path)} : {}),
              ...(c.pool ? {pool: c.pool} : {}),
              ...(c.keyHash ? {key_hash: c.keyHash} : {}),
              ...(c.scriptHash ? {script_hash: c.scriptHash} : {}),
              ...(c.deposit ? {deposit: c.deposit} : {}),
              ...(c.dRep
                ? {
                    drep: {
                      type: c.dRep.type,
                      ...(c.dRep.keyHash ? {key_hash: c.dRep.keyHash} : {}),
                      ...(c.dRep.scriptHash ? {script_hash: c.dRep.scriptHash} : {}),
                    },
                  }
                : {}),
            })),
            withdrawals: trezorRequest.withdrawals?.map((w) => ({
              ...(w.path ? {path: fromTrezorPath(w.path)} : {}),
              ...(w.keyHash ? {key_hash: w.keyHash} : {}),
              ...(w.scriptHash ? {script_hash: w.scriptHash} : {}),
              amount: w.amount,
            })),
            auxiliaryData: trezorRequest.auxiliaryData
              ? {
                  ...(trezorRequest.auxiliaryData.cip36RegistrationParameters
                    ? {
                        cvote_registration_parameters: {
                          voting_public_key: trezorRequest.auxiliaryData.cip36RegistrationParameters.votingPublicKey,
                          staking_path: trezorRequest.auxiliaryData.cip36RegistrationParameters.stakingPath,
                          nonce: trezorRequest.auxiliaryData.cip36RegistrationParameters.nonce,
                          format: trezorRequest.auxiliaryData.cip36RegistrationParameters.format,
                          payment_address_parameters:
                            trezorRequest.auxiliaryData.cip36RegistrationParameters.paymentAddressParameters,
                          ...(trezorRequest.auxiliaryData.cip36RegistrationParameters.delegations
                            ? {
                                delegations: trezorRequest.auxiliaryData.cip36RegistrationParameters.delegations,
                              }
                            : {}),
                        },
                      }
                    : {}),
                }
              : undefined,
            auxiliaryDataHash: trezorRequest.auxiliaryDataHash,
            mint: trezorRequest.mint,
            scriptDataHash: trezorRequest.scriptDataHash,
            collateralInputs: trezorRequest.collateralInputs?.map((i) => ({
              prev_hash: i.prev_hash,
              prev_index: i.prev_index,
            })),
            requiredSigners: trezorRequest.requiredSigners?.map((s) => ({
              ...(s.keyPath ? {key_path: s.keyPath} : {}),
              ...(s.keyHash ? {key_hash: s.keyHash} : {}),
            })),
            collateralReturn: trezorRequest.collateralReturn
              ? {
                  ...(trezorRequest.collateralReturn.address ? {address: trezorRequest.collateralReturn.address} : {}),
                  ...(trezorRequest.collateralReturn.addressParameters
                    ? {address_parameters: toProtoAddressParams(trezorRequest.collateralReturn.addressParameters)}
                    : {}),
                  amount: trezorRequest.collateralReturn.amount,
                  ...(trezorRequest.collateralReturn.tokenBundle
                    ? {tokenBundle: trezorRequest.collateralReturn.tokenBundle}
                    : {}),
                }
              : undefined,
            totalCollateral: trezorRequest.totalCollateral,
            referenceInputs: trezorRequest.referenceInputs?.map((i) => ({
              prev_hash: i.prev_hash,
              prev_index: i.prev_index,
            })),
            witnessPaths: [...(trezorRequest.additionalWitnessRequests ?? [])],
            derivationType: trezorRequest.derivationType,
            includeNetworkId: trezorRequest.includeNetworkId,
            tagCborSets: trezorRequest.tagCborSets,
          })
          return signResult
        })

        // The exit to match the request log above. `hash` is the body hash the
        // *device* computed, which is the one fact that proves what it signed;
        // a short witness set is the failure this whole path guards against, so
        // the count is here rather than inferred later from a submit rejection.
        logger.debug('[Trezor] cardanoSignTx signed', {
          origin: 'TrezorDevice',
          deviceTxHash: result.hash,
          witnesses: result.witnesses.length,
          requestedWitnesses: trezorRequest.additionalWitnessRequests?.length ?? 0,
          hasAuxiliaryDataSupplement: result.auxiliaryDataSupplement !== undefined,
        })

        // Convert witnesses to our format.
        // publicKeyHashHex = blake2b-224(publicKey); it's the dedup key in the downstream
        // witness dict, so leaving it empty collapses multi-signature results into one entry.
        const witnesses: TransactionWitness[] = result.witnesses.map((w) => ({
          publicKeyHashHex: w.pubKey ? bytesToHex(blake2b(hexToBytes(w.pubKey), {dkLen: 28})) : '',
          signatureHex: w.signature,
          publicKeyHex: w.pubKey,
        }))

        // Attach auxiliary data supplement to the first witness (e.g., CIP-36 registration)
        if (result.auxiliaryDataSupplement && witnesses.length > 0 && witnesses[0]) {
          witnesses[0] = {
            ...witnesses[0],
            auxiliaryDataSupplement: {
              auxiliaryDataHashHex: result.auxiliaryDataSupplement.auxiliaryDataHash,
              cip36VoteRegistrationSignatureHex: result.auxiliaryDataSupplement.cip36VoteRegistrationSignature ?? '',
            },
          }
        }

        return witnesses
      }),

    signMessage: (request: MessageSigningRequest) =>
      withSession('signMessage', async (s) => {
        if (isTrezorConnectMethodUnavailable(state.features, 'cardanoSignMessage')) {
          return createUnsupportedFirmwareFailure(
            getMethodUnavailableMessage(state.features, 'cardanoSignMessage', 'Cardano message signing'),
          )
        }

        // Convert derivation path to number array
        const path = fromTrezorPath(request.signingPath)

        const msgNetworkId = request.networkId ?? 1
        const protocolMagic = request.protocolMagic ?? (msgNetworkId === 1 ? 764824073 : 1)

        // CIP-8 message signing uses the CardanoSignMessageInit multi-step protocol.
        // Proto fields: signing_path (id 3), address_parameters (id 6, optional).
        // ADDRESS mode = pass address_parameters so the firmware embeds the full
        // address (not a bare key hash); KEY_HASH mode omits them and the
        // firmware uses blake2b-224(pubkey).
        // Trezor has no hash_payload field — hashing must be done client-side if needed.
        const addressParameters =
          request.addressFieldType === 'address' && request.addressParams
            ? toTrezorMessageAddressParams(request.addressParams)
            : undefined

        const initResult = await s.typedCall('CardanoSignMessageInit', 'CardanoMessageDataRequest', {
          signing_path: path,
          payload_size: request.payloadHex.length / 2,
          prefer_hex_display: request.preferHexDisplay,
          derivation_type: CardanoDerivationType.ICARUS_TREZOR,
          protocol_magic: protocolMagic,
          network_id: msgNetworkId,
          ...(addressParameters ? {address_parameters: addressParameters} : {}),
        })
        if (!initResult.success) return initResult

        // Send message payload chunks
        const MAX_CHUNK_SIZE_HEX = 2048
        let offset = 0
        while (offset < request.payloadHex.length) {
          const chunk = request.payloadHex.slice(offset, offset + MAX_CHUNK_SIZE_HEX)
          const isLast = offset + MAX_CHUNK_SIZE_HEX >= request.payloadHex.length
          const expectedResponse = isLast ? 'CardanoMessageSignature' : 'CardanoMessageDataRequest'

          const chunkResult = await s.typedCall('CardanoMessageDataResponse', expectedResponse, {
            data: chunk,
          })
          if (!chunkResult.success) return chunkResult

          if (isLast) {
            const msg = chunkResult.payload.message
            return {
              success: true as const,
              payload: {
                signature: hexToBytes(msg.signature as string),
                publicKey: hexToBytes(msg.pub_key as string),
                derivationPath: request.signingPath,
              },
            }
          }

          offset += MAX_CHUNK_SIZE_HEX
        }

        return {success: false as const, error: 'Failure_UnexpectedMessage', message: 'No signature received'}
      }),

    verifyAddress: (_address: string, derivationPath: string) =>
      withSession('verifyAddress', async (s) => {
        if (isTrezorConnectMethodUnavailable(state.features, 'cardanoGetAddress')) {
          return createUnsupportedFirmwareFailure(
            getMethodUnavailableMessage(state.features, 'cardanoGetAddress', 'Cardano address verification'),
          )
        }

        // Parse path to determine address type
        const pathParts = derivationPath.split('/')
        const isStaking = pathParts[3] === '2'

        const addressParams: Record<string, unknown> = {
          address_type: isStaking ? CardanoAddressType.REWARD : CardanoAddressType.BASE,
          address_n: parseDerivationPath(derivationPath),
          address_n_staking: isStaking
            ? undefined
            : parseDerivationPath(derivationPath.replace('/0/', '/2/').replace(/\/\d+$/, '/0')),
        }

        const result = await s.typedCall('CardanoGetAddress', 'CardanoAddress', {
          show_display: true,
          protocol_magic: 764824073,
          network_id: 1,
          address_parameters: addressParams,
          derivation_type: CardanoDerivationType.ICARUS_TREZOR,
        })
        if (!result.success) return result

        return {success: true as const, payload: true}
      }),

    getChainApp: (chain: ChainAppType) =>
      Effect.gen(function* () {
        if (!session) {
          return yield* Effect.fail(
            new DeviceNotConnectedError({
              deviceType: 'trezor',
              message: 'Device not connected',
            }),
          )
        }

        // Trezor uses a single TrezorConnect interface — multichain wrappers
        // provide chain-specific method signatures.
        const unsupportedChains: readonly ChainAppType[] = ['tron']
        if (unsupportedChains.includes(chain)) {
          return yield* Effect.fail(
            new HardwareError({
              message: `Chain '${chain}' is not supported by Trezor. Only cardano, bitcoin, litecoin, dogecoin, bitcoin-cash, ethereum, and solana are supported.`,
            }),
          )
        }

        // Build a TrezorConnect-compatible wrapper that delegates to our session
        const activeSession = session
        const sessionWrapper = createSessionWrapper(activeSession, state.features)
        const trezorMultichain = sessionWrapper as unknown as import('./multichain').TrezorConnectMultichain

        const chainFactories: Partial<Record<ChainAppType, () => unknown>> = {
          bitcoin: () => createTrezorBitcoin(trezorMultichain),
          litecoin: () => createTrezorLitecoin(trezorMultichain),
          dogecoin: () => createTrezorDogecoin(trezorMultichain),
          'bitcoin-cash': () => createTrezorBitcoinCash(trezorMultichain),
          ethereum: () => createTrezorEthereum(trezorMultichain),
          solana: () => createTrezorSolana(trezorMultichain),
        }

        const factory = chainFactories[chain]
        if (factory) return factory()

        // Cardano is handled natively by the device
        if (chain === 'cardano') {
          return {
            getExtendedPublicKey: (path: string) =>
              Effect.gen(function* () {
                if (isTrezorConnectMethodUnavailable(state.features, 'cardanoGetPublicKey')) {
                  return yield* Effect.fail(
                    mapTrezorError(
                      new Error(
                        getMethodUnavailableMessage(state.features, 'cardanoGetPublicKey', 'Cardano public key export'),
                      ),
                      'getPublicKey',
                    ),
                  )
                }

                const result = yield* withSession('getExtendedPublicKey', async (s) => {
                  const r = await s.typedCall('CardanoGetPublicKey', 'CardanoPublicKey', {
                    address_n: parseDerivationPath(path),
                    show_display: false,
                    derivation_type: CardanoDerivationType.ICARUS_TREZOR,
                  })
                  if (!r.success) return r
                  const node = r.payload.message.node as {public_key: string; chain_code: string}
                  return {
                    success: true as const,
                    payload: {
                      publicKey: node.public_key,
                      chainCode: node.chain_code,
                    },
                  }
                })
                return result
              }),
            signTransaction: (request: import('../types').CardanoSigningRequest) =>
              device.signCardanoTransaction(request),
            signMessage: (request: import('../types').MessageSigningRequest) => device.signMessage(request),
            verifyAddress: (address: string, derivationPath: string) => device.verifyAddress(address, derivationPath),
          }
        }

        return yield* Effect.fail(new HardwareError({message: `Unknown chain: ${chain}`}))
      }),
  }

  return {
    ...device,
    reconnect: () =>
      Effect.gen(function* () {
        logger.info('Reconnecting: re-acquiring session on existing transport...', {origin: 'TrezorDevice'})

        // Don't call session.release() — it triggers adapter.release() → closeDevice() →
        // USB bus reset → browser disconnect event → provider calls service.disconnect() (race).
        // Instead, pass the old sessionId as `previous` so the transport adapter handles
        // the re-acquisition internally (openDevice with reset, no releaseInterface cycle).
        const prevSession = previousSessionId ?? session?.sessionId
        session = null

        const sessionResult = yield* Effect.tryPromise({
          try: () =>
            acquireSession({
              adapter,
              path: devicePath,
              protocol: 'v1',
              callbacks: getCallbacks(),
              timeout: config.timeout,
              previousSession: prevSession,
            }),
          catch: (error) =>
            new TransportError({
              transportType: 'webusb',
              message: `Failed to re-acquire session: ${error instanceof Error ? error.message : String(error)}`,
              cause: error,
            }),
        })

        if (!sessionResult.success) {
          return yield* Effect.fail(
            new TransportError({
              transportType: 'webusb',
              message: `Failed to re-acquire session: ${sessionResult.message ?? sessionResult.error}`,
            }),
          )
        }

        session = sessionResult.payload
        previousSessionId = session.sessionId
        logger.debug('Session re-acquired', {origin: 'TrezorDevice', sessionId: session.sessionId})

        // Mark as connected — features are preserved from the initial connection.
        // Don't send Initialize here: acquireSession with `previous` already does a USB
        // reset via openDevice({reset: true}), and sending Initialize would produce an extra
        // Features response that could desync subsequent calls.
        state = {...state, connected: true}

        logger.info('Reconnected successfully', {origin: 'TrezorDevice'})
      }),
    updateCallbacks: (callbacks: {
      onPinRequest?: TrezorConfig['onPinRequest']
      onInvalidPin?: TrezorConfig['onInvalidPin']
      onPassphraseRequest?: TrezorConfig['onPassphraseRequest']
      onButtonRequest?: TrezorConfig['onButtonRequest']
      onPairingCode?: TrezorConfig['onPairingCode']
    }) => {
      if (callbacks.onPinRequest !== undefined) mutableConfig = {...mutableConfig, onPinRequest: callbacks.onPinRequest}
      if (callbacks.onInvalidPin !== undefined) mutableConfig = {...mutableConfig, onInvalidPin: callbacks.onInvalidPin}
      if (callbacks.onPassphraseRequest !== undefined)
        mutableConfig = {...mutableConfig, onPassphraseRequest: callbacks.onPassphraseRequest}
      if (callbacks.onButtonRequest !== undefined)
        mutableConfig = {...mutableConfig, onButtonRequest: callbacks.onButtonRequest}
      if (callbacks.onPairingCode !== undefined)
        mutableConfig = {...mutableConfig, onPairingCode: callbacks.onPairingCode}

      if (session) {
        session.updateCallbacks(getCallbacks())
      }
    },
  }
}

/**
 * Creates a TrezorConnect-compatible wrapper around a DeviceSession.
 *
 * This allows the existing multichain wrappers (createTrezorBitcoin, etc.)
 * to work without changes — they call methods like getPublicKey(), getAddress(),
 * signTransaction() which are translated to raw protobuf calls.
 */
const createSessionWrapper = (session: DeviceSession, features?: TrezorDeviceFeatures) => ({
  // Bitcoin methods
  getPublicKey: async (params: {path: string; coin?: string; showOnTrezor?: boolean}) => {
    if (isTaprootDerivationPath(params.path) && isTrezorConnectCapabilityUnavailable(features, 'taproot')) {
      return createUnsupportedFirmwareResponse(
        getCapabilityUnavailableMessage(features, 'taproot', 'Taproot account export'),
      )
    }

    const result = await session.typedCall('GetPublicKey', 'PublicKey', {
      address_n: parseDerivationPath(params.path),
      coin_name: params.coin ?? 'Bitcoin',
      show_display: params.showOnTrezor ?? false,
    })
    if (!result.success) return {success: false, payload: {error: result.message ?? result.error}}
    const msg = result.payload.message
    return {
      success: true,
      payload: {
        publicKey: msg.xpub as string,
        node: {chain_code: (msg.node as {chain_code: string}).chain_code},
      },
    }
  },

  getAddress: async (params: {path: string; coin?: string; showOnTrezor?: boolean; scriptType?: string}) => {
    if (params.scriptType === 'SPENDTAPROOT' && isTrezorConnectCapabilityUnavailable(features, 'taproot')) {
      return createUnsupportedFirmwareResponse(
        getCapabilityUnavailableMessage(features, 'taproot', 'Taproot address export'),
      )
    }

    const result = await session.typedCall('GetAddress', 'Address', {
      address_n: parseDerivationPath(params.path),
      coin_name: params.coin ?? 'Bitcoin',
      show_display: params.showOnTrezor ?? false,
      ...(params.scriptType ? {script_type: params.scriptType} : {}),
    })
    if (!result.success) return {success: false, payload: {error: result.message ?? result.error}}
    return {success: true, payload: {address: result.payload.message.address as string}}
  },

  signTransaction: async (params: {
    inputs: Array<{
      address_n: readonly number[]
      prev_hash: string
      prev_index: number
      amount: string
      script_type?: string
    }>
    outputs: Array<{address?: string; address_n?: readonly number[]; amount: string; script_type?: string}>
    coin?: string
    push?: boolean
    locktime?: number
    version?: number
    refTxs?: ReadonlyMap<string, import('../trezor-protocol/device-session').BitcoinRefTx>
  }) => {
    const usesTaproot =
      params.inputs.some((input) => input.script_type === 'SPENDTAPROOT') ||
      params.outputs.some((output) => output.script_type === 'PAYTOTAPROOT')
    if (usesTaproot && isTrezorConnectCapabilityUnavailable(features, 'taproot')) {
      return createUnsupportedFirmwareResponse(
        getCapabilityUnavailableMessage(features, 'taproot', 'Taproot transaction signing'),
      )
    }

    const useLegacySignProcess = shouldUseLegacyBitcoinSignProcess(features)

    const result = await bitcoinSignTx(session, {
      inputs: params.inputs,
      outputs: params.outputs,
      ...(params.coin !== undefined ? {coin: params.coin} : {}),
      ...(params.version !== undefined ? {version: params.version} : {}),
      ...(params.locktime !== undefined ? {locktime: params.locktime} : {}),
      ...(params.push !== undefined ? {push: params.push} : {}),
      ...(params.refTxs !== undefined ? {refTxs: params.refTxs} : {}),
      useLegacySignProcess,
    })
    if (!result.success) return {success: false, payload: {error: result.message ?? result.error}}
    return {success: true, payload: result.payload}
  },

  signMessage: async (params: {path: string; coin?: string; message: string}) => {
    if (
      isTaprootDerivationPath(params.path) &&
      isTrezorConnectCapabilityUnavailable(features, 'signMessageNoScriptType')
    ) {
      return createUnsupportedFirmwareResponse(
        getCapabilityUnavailableMessage(features, 'signMessageNoScriptType', 'Taproot message signing'),
      )
    }

    const result = await session.typedCall('SignMessage', 'MessageSignature', {
      address_n: parseDerivationPath(params.path),
      coin_name: params.coin ?? 'Bitcoin',
      message: params.message,
    })
    if (!result.success) return {success: false, payload: {error: result.message ?? result.error}}
    const msg = result.payload.message
    return {success: true, payload: {signature: msg.signature as string, address: msg.address as string}}
  },

  // Ethereum methods
  ethereumGetPublicKey: async (params: {path: string; showOnTrezor?: boolean}) => {
    const result = await session.typedCall('EthereumGetPublicKey', 'EthereumPublicKey', {
      address_n: parseDerivationPath(params.path),
      show_display: params.showOnTrezor ?? false,
    })
    if (!result.success) return {success: false, payload: {error: result.message ?? result.error}}
    const msg = result.payload.message
    return {
      success: true,
      payload: {
        publicKey: msg.xpub as string,
        node: {chain_code: (msg.node as {chain_code: string}).chain_code},
      },
    }
  },

  ethereumGetAddress: async (params: {path: string; showOnTrezor?: boolean}) => {
    const result = await session.typedCall('EthereumGetAddress', 'EthereumAddress', {
      address_n: parseDerivationPath(params.path),
      show_display: params.showOnTrezor ?? false,
    })
    if (!result.success) return {success: false, payload: {error: result.message ?? result.error}}
    return {success: true, payload: {address: result.payload.message.address as string}}
  },

  ethereumSignTransaction: async (params: {path: string; transaction: Record<string, unknown>}) => {
    const tx = params.transaction
    const usesEip1559 = tx.maxFeePerGas !== undefined || tx.maxPriorityFeePerGas !== undefined
    if (usesEip1559 && isTrezorConnectCapabilityUnavailable(features, 'eip1559')) {
      return createUnsupportedFirmwareResponse(
        getCapabilityUnavailableMessage(features, 'eip1559', 'EIP-1559 transaction signing'),
      )
    }

    const ethParams: Parameters<typeof ethereumSignTx>[1] = {
      address_n: parseDerivationPath(params.path),
      to: tx.to as string,
      value: tx.value as string,
      gas_limit: tx.gasLimit as string,
      nonce: tx.nonce as string,
      chain_id: tx.chainId as number,
    }
    if (tx.gasPrice !== undefined) ethParams.gas_price = tx.gasPrice as string
    if (tx.maxFeePerGas !== undefined) ethParams.max_fee_per_gas = tx.maxFeePerGas as string
    if (tx.maxPriorityFeePerGas !== undefined) ethParams.max_priority_fee_per_gas = tx.maxPriorityFeePerGas as string
    if (tx.data !== undefined) ethParams.data = tx.data as string
    // Fetch external definitions for token/network display on device
    const definitions = await fetchEthereumDefinitions({
      chainId: tx.chainId as number,
      ...(tx.to != null ? {to: tx.to as string} : {}),
      ...(tx.data != null ? {data: tx.data as string} : {}),
    })
    if (definitions.encoded_network || definitions.encoded_token) {
      ethParams.definitions = definitions
    }
    const result = await ethereumSignTx(session, ethParams)
    if (!result.success) return {success: false, payload: {error: result.message ?? result.error}}
    return {success: true, payload: result.payload}
  },

  ethereumSignMessage: async (params: {path: string; message: string; hex?: boolean}) => {
    const result = await session.typedCall('EthereumSignMessage', 'EthereumMessageSignature', {
      address_n: parseDerivationPath(params.path),
      message: params.message,
      encoded_network: params.hex ? 'hex' : undefined,
    })
    if (!result.success) return {success: false, payload: {error: result.message ?? result.error}}
    const msg = result.payload.message
    return {success: true, payload: {signature: msg.signature as string, address: msg.address as string}}
  },

  ethereumSignTypedData: async (params: {
    path: string
    data: {
      types: Record<string, Array<{name: string; type: string}>>
      primaryType: string
      domain: Record<string, unknown>
      message: Record<string, unknown>
    }
    metamask_v4_compat?: boolean
  }) => {
    if (isTrezorConnectMethodUnavailable(features, 'ethereumSignTypedData')) {
      return createUnsupportedFirmwareResponse(
        getMethodUnavailableMessage(features, 'ethereumSignTypedData', 'Ethereum typed data signing'),
      )
    }

    const result = await ethereumSignTypedData(session, {
      address_n: parseDerivationPath(params.path),
      data: params.data,
      ...(params.metamask_v4_compat !== undefined ? {metamask_v4_compat: params.metamask_v4_compat} : {}),
    })
    if (!result.success) return {success: false as const, payload: {error: result.message ?? result.error}}
    return {success: true as const, payload: result.payload}
  },

  // Solana methods
  solanaGetPublicKey: async (params: {path: string; showOnTrezor?: boolean}) => {
    if (isTrezorConnectMethodUnavailable(features, 'solanaGetPublicKey')) {
      return createUnsupportedFirmwareResponse(
        getMethodUnavailableMessage(features, 'solanaGetPublicKey', 'Solana public key export'),
      )
    }

    const result = await session.typedCall('SolanaGetPublicKey', 'SolanaPublicKey', {
      address_n: parseDerivationPath(params.path),
      show_display: params.showOnTrezor ?? false,
    })
    if (!result.success) return {success: false, payload: {error: result.message ?? result.error}}
    return {success: true, payload: {publicKey: result.payload.message.public_key as string}}
  },

  solanaGetAddress: async (params: {path: string; showOnTrezor?: boolean}) => {
    if (isTrezorConnectMethodUnavailable(features, 'solanaGetAddress')) {
      return createUnsupportedFirmwareResponse(
        getMethodUnavailableMessage(features, 'solanaGetAddress', 'Solana address export'),
      )
    }

    const result = await session.typedCall('SolanaGetAddress', 'SolanaAddress', {
      address_n: parseDerivationPath(params.path),
      show_display: params.showOnTrezor ?? false,
    })
    if (!result.success) return {success: false, payload: {error: result.message ?? result.error}}
    return {success: true, payload: {address: result.payload.message.address as string}}
  },

  solanaSignTransaction: async (params: {
    path: string
    serializedTx: string
    tokenAccountsInfos?: Array<{
      baseAddress: string
      tokenProgram: string
      tokenMint: string
      tokenAccount: string
    }>
  }) => {
    if (isTrezorConnectMethodUnavailable(features, 'solanaSignTransaction')) {
      return createUnsupportedFirmwareResponse(
        getMethodUnavailableMessage(features, 'solanaSignTransaction', 'Solana transaction signing'),
      )
    }

    // Build additional_info with token definition if token accounts are provided
    let additional_info: Parameters<typeof solanaSignTx>[1]['additional_info']
    if (params.tokenAccountsInfos && params.tokenAccountsInfos.length > 0) {
      // Length > 0 guaranteed by outer check, optional chain to satisfy biome no-non-null-assertion
      const mintAddress = params.tokenAccountsInfos[0]?.tokenMint ?? ''
      const encoded_token = mintAddress ? await fetchSolanaTokenDefinition(mintAddress) : undefined
      additional_info = {
        token_accounts_infos: params.tokenAccountsInfos.map((info) => ({
          base_address: info.baseAddress,
          token_program: info.tokenProgram,
          token_mint: info.tokenMint,
          token_account: info.tokenAccount,
        })),
        ...(encoded_token ? {encoded_token} : {}),
      }
    }
    const result = await solanaSignTx(session, {
      address_n: parseDerivationPath(params.path),
      serialized_tx: params.serializedTx,
      ...(additional_info ? {additional_info} : {}),
    })
    if (!result.success) return {success: false, payload: {error: result.message ?? result.error}}
    return {success: true, payload: result.payload}
  },
})

/**
 * Builds a Trezor sign transaction request from our format.
 *
 * Parses the CBOR transaction body and converts all components to
 * Trezor's expected format for signing.
 *
 * @param request - Cardano signing request
 * @returns Effect with Trezor-formatted sign transaction request
 */
const buildTrezorSignRequest = (
  request: CardanoSigningRequest,
): Effect.Effect<TrezorCardanoSignTxRequest, HardwareError> =>
  Effect.gen(function* () {
    // Parse the CBOR transaction body
    const {body, tagCborSets} = yield* parseTransactionBody(request.txBodyHex)

    // Build the Trezor sign request from parsed transaction body.
    // convertToTrezorRequest may throw for unsupported certificates — catch and map to HardwareError.
    return yield* Effect.try({
      try: () =>
        convertToTrezorRequest(body, request.networkId, request.signingPaths, {
          tagCborSets,
          ...(request.cip36Registration ? {cip36Registration: request.cip36Registration} : {}),
          ...(request.protocolMagic !== undefined ? {protocolMagic: request.protocolMagic} : {}),
          ...(request.publicKeys ? {publicKeys: request.publicKeys} : {}),
          ...(request.multisig === true ? {multisig: true} : {}),
        }),
      catch: (e) => new HardwareError({message: e instanceof Error ? e.message : String(e), cause: e}),
    })
  })

/**
 * Converts a derivation path array to Trezor's string format.
 *
 * @param path - Array of path components
 * @returns Path string (e.g., "m/1852'/1815'/0'/0/0")
 */
export const toTrezorPath = (path: readonly number[]): string => {
  const components = path.map((component) => {
    const isHardened = component >= HARDENED
    const index = isHardened ? component - HARDENED : component
    return isHardened ? `${index}'` : String(index)
  })
  return `m/${components.join('/')}`
}

/**
 * Parses a Trezor path string to an array.
 *
 * @param path - Path string (e.g., "m/1852'/1815'/0'/0/0")
 * @returns Array of path components
 */
export const fromTrezorPath = (path: string): readonly number[] => parseDerivationPath(path)
