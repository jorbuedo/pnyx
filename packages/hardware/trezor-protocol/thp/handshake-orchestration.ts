/**
 * THP handshake orchestration.
 *
 * Drives the full channel allocation → Noise_XX handshake → pairing flow
 * for Trezor devices requiring THP v2 (Safe 5/7). After this completes,
 * the returned ThpState holds the encrypted session keys needed for all
 * subsequent protobuf communication.
 *
 * @module
 */

import {bytesToHex, concatBytes, hexToBytes, utf8ToBytes} from '../bytes'
import type {TransportAdapter} from '../device-session'
import {noopLogger, type ProtocolLogger} from '../logger'
import {THP_DEFAULT_CHANNEL} from './constants'
import {getCurve25519KeyPair} from './crypto'
import {getCpaceHostKeys, getSharedSecret, handleHandshakeInit, validateCodeEntryTag} from './pairing'
import {getThpProtobufDefinitions} from './protobuf-definitions'
import {createNewSessionId, createThpState, type ThpState, updateHandshakeCredentials} from './state'
import type {
  ThpCodeEntryCommitment,
  ThpCodeEntryCpaceTrezor,
  ThpCodeEntrySecret,
  ThpCreateChannelResponse,
  ThpCredentialResponse,
  ThpCredentials,
  ThpDeviceProperties,
  ThpHandshakeCompletionResponse,
  ThpHandshakeInitResponse,
} from './types'
import {ThpPairingMethod} from './types'

// --- Result types ---

type Success<T> = {readonly success: true; readonly payload: T}
type ErrorResult = {readonly success: false; readonly error: string; readonly message?: string | undefined}
type Result<T> = Success<T> | ErrorResult

const ok = <T>(payload: T): Success<T> => ({success: true, payload})
const fail = (err: string, message?: string): ErrorResult => ({success: false, error: err, message})

// --- Random bytes helper (works in browsers + Node.js) ---

const getRandomBytes = (n: number): Uint8Array => {
  const bytes = new Uint8Array(n)
  crypto.getRandomValues(bytes)
  return bytes
}

// --- Configuration ---

export type ThpHandshakeConfig = {
  /** Called during CodeEntry pairing when the user must enter the code shown on the device. Return the code string. */
  readonly onPairingCode?: ((prompt: string) => Promise<string>) | undefined
  /** Called when the device requests a passphrase for session creation. Return { value, passphraseOnDevice }. */
  readonly onPassphraseRequest?: (() => Promise<{value: string; passphraseOnDevice?: boolean}>) | undefined
  /** Whether the device has passphrase protection enabled (from Features). Defaults to false. */
  readonly passphraseProtection?: boolean | undefined
  /** Host name sent to device during pairing (default: 'Pnyx') */
  readonly hostName?: string | undefined
  /** App name sent to device during pairing (default: 'Pnyx') */
  readonly appName?: string | undefined
  /** Where this handshake narrates itself. `trezor/device.ts` passes the app's. */
  readonly logger?: ProtocolLogger | undefined
  /**
   * Previously persisted pairing credentials for this device.
   * When provided, the handshake sets tryToUnlock=1 so the device recognises
   * the stored host_pairing_credential and can skip re-pairing.
   */
  readonly knownCredentials?: ThpCredentials[] | undefined
  /** Request autoconnect permission during pairing (default: false). When true, the device may allow future connections without user confirmation. */
  readonly autoconnect?: boolean | undefined
  /**
   * Permit unattested `SkipPairing` when the device offers no CodeEntry method
   * (default: false). Only for dev/testing against a known device/emulator —
   * production must leave this off so a swapped device can't skip attestation.
   */
  readonly allowSkipPairing?: boolean | undefined
}

// --- Handshake orchestration ---

/**
 * Performs the full THP handshake for a Trezor device requiring v2 protocol.
 *
 * Steps:
 * 1. Channel allocation (ThpCreateChannelRequest → ThpCreateChannelResponse)
 * 2. Noise_XX handshake (Init → Completion, derives session encryption keys)
 * 3. Pairing (if device is not already paired — SkipPairing or CodeEntry)
 * 4. Session creation (ThpCreateNewSession)
 *
 * After this returns successfully, the ThpState can be used with
 * `acquireSession({protocol: 'v2', thpState})` for encrypted communication.
 */
// Max retries when the device reports ThpTransportBusy (stale channel from a previous connection)
const BUSY_RETRY_LIMIT = 3
const BUSY_RETRY_DELAY_MS = 1000

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export const performThpHandshake = async (
  adapter: TransportAdapter,
  sessionId: string,
  config?: ThpHandshakeConfig,
): Promise<Result<ThpState>> => {
  const logger = config?.logger ?? noopLogger

  for (let attempt = 0; attempt < BUSY_RETRY_LIMIT; attempt++) {
    const result = await performThpHandshakeOnce(adapter, sessionId, config, logger)
    if (result.success || result.error !== 'ThpTransportBusy') return result

    logger.debug(`ThpTransportBusy — retrying handshake (${attempt + 1}/${BUSY_RETRY_LIMIT})`, {
      origin: 'THP',
    })
    await delay(BUSY_RETRY_DELAY_MS)
  }

  return fail('ThpTransportBusy', 'Device transport busy after retries')
}

const performThpHandshakeOnce = async (
  adapter: TransportAdapter,
  sessionId: string,
  config: ThpHandshakeConfig | undefined,
  logger: ProtocolLogger,
): Promise<Result<ThpState>> => {
  const thpState = createThpState()
  const hostName = config?.hostName ?? 'Pnyx'
  const appName = config?.appName ?? 'Pnyx'

  // Load previously persisted credentials so the handshake can attempt reconnect
  if (config?.knownCredentials?.length) {
    thpState.pairingCredentials = [...config.knownCredentials]
  }

  // Load THP protobuf definitions into the adapter's message registry
  await adapter.loadMessages('thp', getThpProtobufDefinitions)

  // Helper: send a THP message via the adapter's v2 call path.
  // Handles ButtonRequest interrupts automatically (sends ButtonAck, waits for actual response),
  // similar to the typedCall interrupt loop for v1 messages.
  const thpCall = async (
    name: string,
    data: Record<string, unknown>,
  ): Promise<Result<{type: string; message: Record<string, unknown>}>> => {
    logger.debug('thpCall', {origin: 'THP', name})
    let result = await adapter.call({
      session: sessionId,
      name,
      data,
      protocol: 'v2',
      thpState,
    })

    // Handle interrupt responses (ButtonRequest, PinMatrixRequest, etc.)
    while (result.success) {
      const payload = result.payload as {type: string; message: Record<string, unknown>}

      if (payload.type === 'ButtonRequest') {
        logger.debug('ButtonRequest — user must confirm on device', {origin: 'THP', name})
        // Acknowledge and wait for user to confirm on device
        result = await adapter.call({
          session: sessionId,
          name: 'ButtonAck',
          data: {},
          protocol: 'v2',
          thpState,
        })
        continue
      }

      if (payload.type === 'Failure' || payload.type === 'ThpError') {
        const msg = (payload.message as {message?: string}).message ?? 'Unknown failure'
        const code = (payload.message as {code?: string}).code ?? payload.type
        logger.debug(`thpCall → ${payload.type}: ${code} ${msg}`, {origin: 'THP', name})
        return fail(code, msg)
      }

      logger.debug(`thpCall → ${payload.type}`, {origin: 'THP', name})
      return ok(payload)
    }

    logger.debug(`thpCall failed: ${(result as ErrorResult).error}`, {
      origin: 'THP',
      name,
      message: (result as ErrorResult).message,
    })
    return result as ErrorResult
  }

  // --- Step 1: Channel allocation ---

  // Use the default broadcast channel for the initial request.
  // receiveExpectedMessage validates channel match, so this must be set
  // before the first call (the response arrives on the default channel).
  thpState.channel = THP_DEFAULT_CHANNEL

  const nonce = getRandomBytes(8)
  const channelResult = await thpCall('ThpCreateChannelRequest', {nonce})
  if (!channelResult.success) return channelResult

  const channelResponse = channelResult.payload.message as unknown as ThpCreateChannelResponse
  thpState.channel =
    channelResponse.channel instanceof Uint8Array
      ? channelResponse.channel
      : hexToBytes(channelResponse.channel as unknown as string)
  thpState.properties = channelResponse.properties as ThpDeviceProperties

  // THP 2.1 negotiation. A device reporting `protocol_version_minor > 0` expects the host to say it
  // speaks 2.1 by setting the ack bit on the HANDSHAKE_INIT_REQ magic byte; this value is what
  // `handshakeInitRequest` reads. Availability only — piggybacking an ack onto a real message is a
  // separate opt-in that upstream uses for bulk flows and never during pairing.
  thpState.piggybackAckAvailable = (thpState.properties.protocol_version_minor ?? 0) > 0

  logger.debug('THP device properties', {
    origin: 'THP',
    internalModel: thpState.properties.internal_model,
    protocolVersionMajor: thpState.properties.protocol_version_major,
    protocolVersionMinor: thpState.properties.protocol_version_minor,
    pairingMethods: thpState.properties.pairing_methods,
    piggybackAckAvailable: thpState.piggybackAckAvailable,
  })

  // Extract pairing methods from device properties
  const pairingMethods = (thpState.properties.pairing_methods ?? []).map((m) => {
    if (typeof m === 'number') return m
    return ThpPairingMethod[m as keyof typeof ThpPairingMethod]
  })

  updateHandshakeCredentials(thpState, {
    handshakeHash:
      channelResponse.handshakeHash instanceof Uint8Array
        ? channelResponse.handshakeHash
        : hexToBytes(channelResponse.handshakeHash as unknown as string),
    pairingMethods,
  })

  // --- Step 2: Noise_XX handshake ---

  // Generate ephemeral X25519 keypair
  const hostEphemeralKeys = getCurve25519KeyPair(getRandomBytes(32))

  // Signal the device to check the embedded credential when we have known credentials
  const tryToUnlock: 0 | 1 = thpState.pairingCredentials.length > 0 ? 1 : 0

  const handshakeInitResult = await thpCall('ThpHandshakeInitRequest', {
    key: hostEphemeralKeys.publicKey,
    tryToUnlock,
  })
  if (!handshakeInitResult.success) return handshakeInitResult

  const initResponse = handshakeInitResult.payload.message as unknown as ThpHandshakeInitResponse

  // Run Noise_XX protocol steps — derives session encryption keys
  // Manual protobuf encoder for ThpHandshakeCompletionReqNoisePayload.
  // This message has one optional bytes field: host_pairing_credential (id=1).
  // Protobuf wire format: field tag (id << 3 | wire_type=2 for bytes) + varint length + data.
  const protobufEncoder = (_name: string, data: Record<string, unknown>): {message: Uint8Array} => {
    const credential = data.host_pairing_credential
    if (!credential) return {message: new Uint8Array(0)}
    const credBytes = typeof credential === 'string' ? hexToBytes(credential) : new Uint8Array(credential as Uint8Array)
    // Field 1, wire type 2 (length-delimited) → tag byte = (1 << 3) | 2 = 0x0a
    const tag = new Uint8Array([0x0a])
    // Varint length (credential is typically < 128 bytes)
    const len = credBytes.length
    const lenBytes = len < 128 ? new Uint8Array([len]) : new Uint8Array([0x80 | (len & 0x7f), len >> 7])
    return {message: concatBytes(tag, lenBytes, credBytes)}
  }

  const ensureUint8Array = (value: Uint8Array | unknown): Uint8Array =>
    value instanceof Uint8Array ? value : hexToBytes(value as unknown as string)

  const handshakeResult = handleHandshakeInit({
    handshakeInitResponse: {
      trezorEphemeralPubkey: ensureUint8Array(initResponse.trezorEphemeralPubkey),
      trezorEncryptedStaticPubkey: ensureUint8Array(initResponse.trezorEncryptedStaticPubkey),
      tag: ensureUint8Array(initResponse.tag),
    },
    thpState,
    knownCredentials: thpState.pairingCredentials,
    hostEphemeralKeys,
    tryToUnlock,
    protobufEncoder,
    randomBytes: getRandomBytes,
  })

  // Update thpState with derived keys
  updateHandshakeCredentials(thpState, {
    hostKey: handshakeResult.hostKey,
    trezorKey: handshakeResult.trezorKey,
    handshakeHash: handshakeResult.handshakeHash,
    trezorEncryptedStaticPubkey: handshakeResult.trezorEncryptedStaticPubkey,
    hostEncryptedStaticPubkey: handshakeResult.hostEncryptedStaticPubkey,
    staticKey: handshakeResult.staticKey,
    hostStaticPublicKey: handshakeResult.hostStaticKeys.publicKey,
  })

  // Send handshake completion
  const completionResult = await thpCall('ThpHandshakeCompletionRequest', {
    hostPubkey: handshakeResult.hostEncryptedStaticPubkey,
    encryptedPayload: handshakeResult.encryptedPayload,
  })
  if (!completionResult.success) return completionResult

  const completionResponse = completionResult.payload.message as unknown as ThpHandshakeCompletionResponse
  const pairingState = completionResponse.state

  // --- Step 3: Pairing (if needed) ---

  if (pairingState === 0) {
    // Device rejected our credentials (if any were sent) — remove stale ones
    if (tryToUnlock === 1 && handshakeResult.credentials) {
      const staleIndex = thpState.pairingCredentials.findIndex(
        (c) => c.credential === handshakeResult.credentials?.credential,
      )
      if (staleIndex >= 0) {
        thpState.pairingCredentials.splice(staleIndex, 1)
        logger.debug('Removed rejected THP credential', {origin: 'THP'})
      }
    }

    // Device is not paired — run full pairing flow
    const pairingResult = await performPairing(thpCall, thpState, pairingMethods, {
      hostName,
      appName,
      hostStaticPublicKey: handshakeResult.hostStaticKeys.publicKey,
      onPairingCode: config?.onPairingCode,
      autoconnect: config?.autoconnect,
      allowSkipPairing: config?.allowSkipPairing,
      logger,
    })
    if (!pairingResult.success) return pairingResult
  } else if (pairingState === 1) {
    // Device has credentials but requires per-connection user confirmation.
    // Send ThpCredentialRequest which triggers a ButtonRequest on the device
    // for the user to confirm, then ThpEndRequest to finalize.
    thpState.isPaired = true
    if (thpState.handshakeCredentials) {
      const credResult = await thpCall('ThpCredentialRequest', {
        host_static_public_key: bytesToHex(thpState.handshakeCredentials.hostStaticPublicKey),
        autoconnect: config?.autoconnect ?? false,
      })
      if (!credResult.success) return credResult
    }
    const endResult = await thpCall('ThpEndRequest', {})
    if (!endResult.success) return endResult
    thpState.phase = 'paired'
  } else {
    // state 2: autoconnect — credentials recognized, no user interaction needed
    thpState.isPaired = true
    const endResult = await thpCall('ThpEndRequest', {})
    if (!endResult.success) return endResult
    thpState.phase = 'paired'
  }

  // --- Step 4: Create THP session ---

  // Advance the session ID counter to 0x01 BEFORE sending ThpCreateNewSession.
  // The session_id embedded in the encrypted frame tells the device which ID to
  // assign to the new session — the host picks the ID, the device echoes it back.
  // Sending with 0x00 (bootstrap) would create a session with id 0x00, and
  // subsequent messages with id 0x01 would be rejected as unknown session.
  createNewSessionId(thpState)

  // Build session creation params — handle passphrase if device has it enabled.
  // NOTE: Features aren't available yet during the handshake (retrieved after via GetFeatures).
  // The caller must set passphraseProtection from cached device info for passphrase devices.
  let sessionParams: Record<string, unknown> = {derive_cardano: true, passphrase: ''}
  if (config?.passphraseProtection && config.onPassphraseRequest) {
    try {
      const pp = await config.onPassphraseRequest()
      sessionParams = pp.passphraseOnDevice
        ? {derive_cardano: true, on_device: true}
        : {derive_cardano: true, passphrase: pp.value.normalize('NFKD')}
    } catch (e: unknown) {
      // ⚠️ The fallback is an EMPTY passphrase, which derives a different wallet than the one the
      // user was asked for. Ordinarily that is a deliberate cancellation; a callback that threw
      // for any other reason silently lands the session on the no-passphrase wallet.
      logger.warn('Passphrase request failed; falling back to the empty-passphrase session', {
        origin: 'trezor/thp-handshake',
        error: String(e),
      })
      sessionParams = {derive_cardano: true, passphrase: ''}
    }
  } else if (config?.passphraseProtection) {
    // Passphrase enabled but no callback — use empty passphrase
    sessionParams = {derive_cardano: true, passphrase: ''}
  }

  const sessionResult = await thpCall('ThpCreateNewSession', sessionParams)
  if (!sessionResult.success) return sessionResult

  return ok(thpState)
}

// --- Pairing sub-flow ---

/**
 * Choose a THP pairing method from the device-advertised list.
 *
 * Prefers the user-verified CodeEntry method — but only when the host can
 * actually run it (`hasPairingCode`, i.e. an `onPairingCode` callback is
 * available); otherwise CodeEntry would be selected only to dead-end at
 * `ThpPairingCodeRequired`. SkipPairing (which proves only possession of the
 * device static key, not device authenticity) is chosen ONLY when the host
 * explicitly opts in and CodeEntry can't be run. Returns `null` when no usable
 * method is offered — the caller must then refuse to pair rather than silently
 * skip (M-010).
 */
export const selectThpPairingMethod = (
  pairingMethods: readonly number[],
  allowSkipPairing = false,
  hasPairingCode = true,
): ThpPairingMethod.CodeEntry | ThpPairingMethod.SkipPairing | null => {
  if (hasPairingCode && pairingMethods.includes(ThpPairingMethod.CodeEntry)) return ThpPairingMethod.CodeEntry
  if (allowSkipPairing && pairingMethods.includes(ThpPairingMethod.SkipPairing)) return ThpPairingMethod.SkipPairing
  return null
}

const performPairing = async (
  thpCall: (
    name: string,
    data: Record<string, unknown>,
  ) => Promise<Result<{type: string; message: Record<string, unknown>}>>,
  thpState: ThpState,
  pairingMethods: number[],
  options: {
    hostName: string
    appName: string
    hostStaticPublicKey: Uint8Array
    onPairingCode?: ((prompt: string) => Promise<string>) | undefined
    autoconnect?: boolean | undefined
    /**
     * Permit `SkipPairing` (no user-verified out-of-band check). Defaults to
     * false: SkipPairing proves possession of the device's static key but NOT
     * device authenticity, so auto-accepting it lets a swapped/supply-chain
     * device become the trusted peer with no attestation. Only enable for
     * dev/testing against a known device.
     */
    allowSkipPairing?: boolean | undefined
    readonly logger?: ProtocolLogger | undefined
  },
): Promise<Result<void>> => {
  // Determine the pairing method BEFORE prompting the device. The choice
  // depends only on the advertised list, the SkipPairing opt-in, and whether a
  // pairing-code callback exists — all known now. Refusing here means the
  // device never shows a confirm prompt that would then hang waiting for a
  // ThpSelectMethod we won't send. The device advertises the list, so an
  // attacker-impersonated device must not be able to force an unattested
  // SkipPairing.
  const method = selectThpPairingMethod(
    pairingMethods,
    options.allowSkipPairing === true,
    options.onPairingCode != null,
  )
  if (method === null) {
    return fail(
      'ThpPairingUnsupported',
      'Device offers no usable pairing method (CodeEntry needs a pairing-code callback; SkipPairing not permitted); refusing to pair',
    )
  }

  // The device answers a bad pairing request with a bare `Failure_FirmwareError` naming no
  // field, so the inputs have to be in the log or the failure is undiagnosable.
  options.logger?.debug('THP pairing request', {
    origin: 'THP',
    offeredMethods: pairingMethods,
    selectedMethod: method,
    hostName: options.hostName,
    appName: options.appName,
  })
  // Send pairing request — user must confirm on device
  const pairingReqResult = await thpCall('ThpPairingRequest', {
    host_name: options.hostName,
    app_name: options.appName,
  })
  if (!pairingReqResult.success) return pairingReqResult

  return method === ThpPairingMethod.CodeEntry
    ? performCodeEntryPairing(thpCall, thpState, options)
    : performSkipPairing(thpCall, thpState)
}

// --- SkipPairing flow ---

const performSkipPairing = async (
  thpCall: (
    name: string,
    data: Record<string, unknown>,
  ) => Promise<Result<{type: string; message: Record<string, unknown>}>>,
  thpState: ThpState,
): Promise<Result<void>> => {
  const selectResult = await thpCall('ThpSelectMethod', {
    selected_pairing_method: ThpPairingMethod.SkipPairing,
  })
  if (!selectResult.success) return selectResult

  thpState.isPaired = true
  thpState.phase = 'paired'
  thpState.selectedMethod = ThpPairingMethod.SkipPairing

  return ok(undefined)
}

// --- CodeEntry pairing flow ---

const performCodeEntryPairing = async (
  thpCall: (
    name: string,
    data: Record<string, unknown>,
  ) => Promise<Result<{type: string; message: Record<string, unknown>}>>,
  thpState: ThpState,
  options: {
    hostStaticPublicKey: Uint8Array
    onPairingCode?: ((prompt: string) => Promise<string>) | undefined
    autoconnect?: boolean | undefined
    readonly logger?: ProtocolLogger | undefined
  },
): Promise<Result<void>> => {
  if (!thpState.handshakeCredentials) return fail('ThpStateMissing', 'Handshake credentials not available')

  // Select CodeEntry method — response IS the ThpCodeEntryCommitment
  const selectResult = await thpCall('ThpSelectMethod', {
    selected_pairing_method: ThpPairingMethod.CodeEntry,
  })
  if (!selectResult.success) return selectResult
  thpState.selectedMethod = ThpPairingMethod.CodeEntry

  // The commitment comes directly from the ThpSelectMethod response
  const commitment = selectResult.payload.message as unknown as ThpCodeEntryCommitment
  updateHandshakeCredentials(thpState, {
    handshakeCommitment: hexToBytes(commitment.commitment),
  })

  // Send challenge
  const challenge = getRandomBytes(32)
  updateHandshakeCredentials(thpState, {codeEntryChallenge: challenge})

  const challengeResult = await thpCall('ThpCodeEntryChallenge', {
    challenge: bytesToHex(challenge),
  })
  if (!challengeResult.success) return challengeResult

  // Receive Trezor CPACE public key
  const cpaceResponse = challengeResult.payload.message as unknown as ThpCodeEntryCpaceTrezor
  updateHandshakeCredentials(thpState, {
    trezorCpacePublicKey: hexToBytes(cpaceResponse.cpace_trezor_public_key),
  })

  // Get code from user
  if (!options.onPairingCode) {
    return fail('ThpPairingCodeRequired', 'CodeEntry pairing requires onPairingCode callback')
  }

  const code = await options.onPairingCode('Enter the code displayed on your Trezor device')

  // Fed verbatim, as upstream does. The CPace prefix ends in 0x06 — a length prefix asserting a
  // 6-byte code — so padding a short code would agree with the prefix while disagreeing with the
  // digits the device hashed, and the tag would fail to verify with no indication why.
  // CPace's prefix asserts a 6-byte code; anything else derives a different generator and the
  // tag fails to verify with no other symptom.
  options.logger?.debug('THP code entry', {origin: 'THP', codeLength: code.length})
  const codeBytes = utf8ToBytes(code)
  const cpaceHostKeys = getCpaceHostKeys(codeBytes, thpState.handshakeCredentials.handshakeHash, getRandomBytes)
  const sharedSecret = getSharedSecret(hexToBytes(cpaceResponse.cpace_trezor_public_key), cpaceHostKeys.privateKey)

  // Send host CPACE tag
  const cpaceTagResult = await thpCall('ThpCodeEntryCpaceHostTag', {
    cpace_host_public_key: bytesToHex(cpaceHostKeys.publicKey),
    tag: bytesToHex(sharedSecret),
  })
  if (!cpaceTagResult.success) return cpaceTagResult

  // Receive and validate secret.
  //
  // Converted to a typed failure rather than left to throw: every other outcome in this function
  // returns a `Result`, so an uncaught throw here escaped `performThpHandshake` as a raw exception and
  // the UI had nothing to render. This is also the step that decides whether the peer is who it claims
  // — a mismatch means a mistyped code or a device that cannot prove itself — so it deserves a name.
  // Upstream does the same, mapping it to `Device_ThpPairingTagInvalid`.
  const secretResponse = cpaceTagResult.payload.message as unknown as ThpCodeEntrySecret
  try {
    validateCodeEntryTag(thpState.handshakeCredentials, code, secretResponse.secret)
  } catch (error) {
    options.logger?.debug('THP code entry tag rejected', {
      origin: 'THP',
      reason: error instanceof Error ? error.message : String(error),
    })
    return fail('ThpPairingTagInvalid', error instanceof Error ? error.message : 'code entry tag mismatch')
  }

  // Request credential
  const credentialResult = await thpCall('ThpCredentialRequest', {
    host_static_public_key: bytesToHex(options.hostStaticPublicKey),
    autoconnect: options.autoconnect ?? false,
  })
  if (!credentialResult.success) return credentialResult

  const credentialResponse = credentialResult.payload.message as unknown as ThpCredentialResponse
  thpState.pairingCredentials.push({
    trezor_static_public_key: credentialResponse.trezor_static_public_key,
    credential: credentialResponse.credential,
    host_static_key: bytesToHex(thpState.handshakeCredentials.staticKey),
  })

  // End pairing
  const endResult = await thpCall('ThpEndRequest', {})
  if (!endResult.success) return endResult

  thpState.isPaired = true
  thpState.phase = 'paired'

  return ok(undefined)
}
