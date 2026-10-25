/**
 * Device session management.
 *
 * Wraps the transport adapter + call-loop into a session that provides
 * `typedCall` and multi-step signing capabilities. Handles protocol
 * selection (v1 vs THP) and session lifecycle.
 *
 * Replaces @trezor/connect's DeviceCommands + DeviceCurrentSession.
 *
 * @module
 */

import {bytesToHex, utf8ToBytes} from './bytes'
import {typedCall as callLoop, type DeviceCallbacks, type TransportCall} from './call-loop'
import type {MessageResponse} from './protobuf'

const HARDENED_OFFSET = 0x80000000

/** Parses "m/1852'/1815'/0'/0/0" → [0x8000073C, 0x80000717, 0x80000000, 0, 0] */
const parsePathString = (path: string): number[] => {
  const parts = path.replace(/^m\/?/, '').split('/')
  return parts.map((part) => {
    const hardened = part.endsWith("'") || part.endsWith('h')
    const value = parseInt(hardened ? part.slice(0, -1) : part, 10)
    return hardened ? value + HARDENED_OFFSET : value
  })
}

// --- Result types ---

type Success<T> = {readonly success: true; readonly payload: T}
type ErrorResult = {readonly success: false; readonly error: string; readonly message?: string | undefined}
type Result<T> = Success<T> | ErrorResult

const ok = <T>(payload: T): Success<T> => ({success: true, payload})
const fail = (err: string, message?: string): ErrorResult => ({success: false, error: err, message})

// --- Transport adapter interface ---

/**
 * Minimal interface for the transport adapter used by device session.
 * Matches the shape returned by createTransportAdapter.
 */
export type TransportAdapter = {
  readonly call: (params: {
    session: string
    name: string
    data: Record<string, unknown>
    signal?: AbortSignal | undefined
    timeout?: number | undefined
    protocol?: 'v1' | 'v2' | undefined
    thpState?: unknown
  }) => Promise<Result<MessageResponse> | ErrorResult>
  /** Receive-only: read the next message without sending. Used to drain stale USB responses. */
  readonly receive?:
    | ((params: {
        session: string
        signal?: AbortSignal | undefined
        timeout?: number | undefined
        protocol?: 'v1' | 'v2' | undefined
        thpState?: unknown
      }) => Promise<Result<MessageResponse> | ErrorResult>)
    | undefined
  readonly enumerate: (params?: {signal?: AbortSignal}) => Promise<unknown>
  readonly acquire: (params: {
    input: {path: string; previous: string | null}
    signal?: AbortSignal
  }) => Promise<Result<string>>
  readonly release: (params: {path: string; session: string; signal?: AbortSignal}) => Promise<unknown>
  readonly updateMessages: (messages: unknown) => void
  readonly loadMessages: (packageName: string, packageLoader: () => unknown) => Promise<void>
}

// --- Device session ---

export type DeviceSessionConfig = {
  /** Transport adapter instance */
  readonly adapter: TransportAdapter
  /** Device path (from enumeration) */
  readonly path: string
  /** Protocol to use */
  readonly protocol: 'v1' | 'v2'
  /** THP state (required for v2 protocol) */
  readonly thpState?: unknown
  /** UI callbacks for PIN, passphrase, button */
  readonly callbacks?: DeviceCallbacks | undefined
  /** Session timeout in milliseconds */
  readonly timeout?: number | undefined
  /** Previous session ID for proper session release on re-acquire */
  readonly previousSession?: string | undefined
}

export type DeviceSession = {
  /** The acquired session ID */
  readonly sessionId: string

  /**
   * Typed call: send a protobuf message and handle device interrupts.
   *
   * This is the core API — equivalent to @trezor/connect's `typedCall`.
   * Handles ButtonRequest/PinMatrixRequest/PassphraseRequest loops automatically.
   */
  readonly typedCall: (
    messageName: string,
    expectedType: string | readonly string[],
    data?: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<Result<MessageResponse>>

  /**
   * Raw transport call (no interrupt handling).
   */
  readonly rawCall: TransportCall

  /** Release the session */
  readonly release: () => Promise<void>

  /** Update UI callbacks */
  readonly updateCallbacks: (callbacks: Partial<DeviceCallbacks>) => void
}

/**
 * Acquires a session on the transport adapter and returns a DeviceSession.
 *
 * The session wraps the adapter's `call` method with the call-loop's
 * interrupt handling, providing the `typedCall` API.
 */
export const acquireSession = async (config: DeviceSessionConfig): Promise<Result<DeviceSession>> => {
  const {adapter, path, protocol, thpState, timeout} = config
  let callbacks = config.callbacks ?? {}

  // Acquire session from the transport adapter
  const acquireResult = await adapter.acquire({
    input: {path, previous: config.previousSession ?? null},
  })
  if (!acquireResult.success) return acquireResult

  const sessionId = acquireResult.payload

  // Build the raw transport call function
  const rawCall: TransportCall = async (name, data, options) => {
    // When receiveOnly is set, skip sending and just read the next message.
    // Used by the call-loop to drain stale responses from the USB buffer.
    if (options?.receiveOnly) {
      if (!adapter.receive) {
        return fail('Failure_UnexpectedMessage', 'Transport does not support receive-only reads')
      }
      const result = await adapter.receive({
        session: sessionId,
        protocol,
        thpState,
        signal: options?.signal,
        timeout: options?.timeout ?? timeout,
      })
      return result as Result<MessageResponse>
    }

    const callParams: {
      session: string
      name: string
      data: Record<string, unknown>
      protocol: 'v1' | 'v2'
      thpState?: unknown
      signal?: AbortSignal | undefined
      timeout?: number | undefined
    } = {
      session: sessionId,
      name,
      data,
      protocol,
      thpState,
    }
    if (options?.signal) callParams.signal = options.signal
    const effectiveTimeout = options?.timeout ?? timeout
    if (effectiveTimeout !== undefined) callParams.timeout = effectiveTimeout
    const result = await adapter.call(callParams)
    return result as Result<MessageResponse>
  }

  // Build typedCall with interrupt handling
  const sessionTypedCall = (
    messageName: string,
    expectedType: string | readonly string[],
    data: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<Result<MessageResponse>> => {
    return callLoop(rawCall, messageName, expectedType, data, callbacks, signal)
  }

  const release = async (): Promise<void> => {
    await adapter.release({path, session: sessionId})
  }

  const updateCallbacks = (newCallbacks: Partial<DeviceCallbacks>): void => {
    callbacks = {...callbacks, ...newCallbacks}
  }

  return ok({
    sessionId,
    typedCall: sessionTypedCall,
    rawCall,
    release,
    updateCallbacks,
  })
}

// --- Upgrade session to v2 protocol ---

/**
 * Upgrades an existing session to THP v2 protocol without releasing the USB device.
 *
 * After a THP handshake completes, the USB session must NOT be released before
 * sending the first v2 message. Calling `release()` triggers `closeDevice()` which
 * does `device.reset()` (USB bus reset) — and Trezor firmware clears THP sessions
 * on USB reset, causing `Failure_UnexpectedMessage` on the subsequent `Initialize`.
 *
 * This creates a new DeviceSession wrapper that reuses the existing transport
 * session ID (same USB path) but sends all messages with `protocol: 'v2'` and
 * the provided `thpState`.
 */
export const upgradeToV2Session = (
  adapter: TransportAdapter,
  existingSession: DeviceSession,
  thpState: unknown,
  callbacks: DeviceCallbacks,
  timeout?: number,
): DeviceSession => {
  let currentCallbacks = callbacks

  const rawCall: TransportCall = async (name, data, options) => {
    if (options?.receiveOnly) {
      if (!adapter.receive) {
        return {
          success: false as const,
          error: 'Failure_UnexpectedMessage',
          message: 'Transport does not support receive-only reads',
        }
      }
      const result = await adapter.receive({
        session: existingSession.sessionId,
        protocol: 'v2',
        thpState,
        signal: options?.signal,
        timeout: options?.timeout ?? timeout,
      })
      return result as Result<MessageResponse>
    }

    const callParams: {
      session: string
      name: string
      data: Record<string, unknown>
      protocol: 'v2'
      thpState: unknown
      signal?: AbortSignal
      timeout?: number
    } = {
      session: existingSession.sessionId,
      name,
      data,
      protocol: 'v2',
      thpState,
    }
    if (options?.signal) callParams.signal = options.signal
    const effectiveTimeout = options?.timeout ?? timeout
    if (effectiveTimeout !== undefined) callParams.timeout = effectiveTimeout
    return adapter.call(callParams) as Promise<Result<MessageResponse>>
  }

  const sessionTypedCall = (
    messageName: string,
    expectedType: string | readonly string[],
    data: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<Result<MessageResponse>> => {
    return callLoop(rawCall, messageName, expectedType, data, currentCallbacks, signal)
  }

  const updateCallbacks = (newCallbacks: Partial<DeviceCallbacks>): void => {
    currentCallbacks = {...currentCallbacks, ...newCallbacks}
  }

  return {
    sessionId: existingSession.sessionId,
    typedCall: sessionTypedCall,
    rawCall,
    release: existingSession.release,
    updateCallbacks,
  }
}

// --- Initialize device ---

/**
 * Initializes a Trezor device session.
 *
 * Sends `Initialize` to reset the device state and get Features.
 * This must be the first call after acquiring a session.
 */
export const initializeDevice = async (
  session: DeviceSession,
  options?: {deriveCardano?: boolean},
): Promise<Result<MessageResponse>> => {
  return session.typedCall('Initialize', 'Features', {
    derive_cardano: options?.deriveCardano ?? true,
  })
}

// --- Cardano multi-step signing ---

/**
 * Maximum chunk size for inline datum and reference script data.
 * Matches @trezor/connect's MAX_CHUNK_SIZE = 1024 bytes = 2048 hex chars.
 */
const MAX_CHUNK_SIZE_HEX = 2048

/**
 * Sends chunked hex data to the device.
 * Used for inline datums and reference scripts that exceed the chunk limit.
 */
const sendChunkedHexData = async (
  session: DeviceSession,
  data: string,
  messageType: string,
  signal?: AbortSignal,
): Promise<Result<MessageResponse>> => {
  let processedSize = 0
  let lastResult: Result<MessageResponse> | undefined

  while (processedSize < data.length) {
    const chunk = data.slice(processedSize, processedSize + MAX_CHUNK_SIZE_HEX)
    const result = await session.typedCall(messageType, 'CardanoTxItemAck', {data: chunk}, signal)
    if (!result.success) return result
    lastResult = result
    processedSize += MAX_CHUNK_SIZE_HEX
  }

  return lastResult ?? fail('Failure_UnexpectedMessage', 'Empty chunked data')
}

/**
 * Sends a Cardano output with its token bundle, inline datum, and reference script.
 */
const sendCardanoOutput = async (
  session: DeviceSession,
  output: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Result<MessageResponse>> => {
  const tokenBundle = output.tokenBundle as
    | ReadonlyArray<{policyId: string; tokenAmounts: ReadonlyArray<Record<string, unknown>>}>
    | undefined
  const inlineDatum = output.inlineDatum as string | undefined
  const referenceScript = output.referenceScript as string | undefined

  // Build output protobuf data with snake_case field names.
  // Our encoder does not auto-convert camelCase → snake_case.
  const outputData: Record<string, unknown> = {
    address: output.address,
    amount: output.amount,
    format: output.format,
    ...(output.datumHash || output.datum_hash ? {datum_hash: output.datumHash ?? output.datum_hash} : {}),
    ...(output.addressParameters || output.address_parameters
      ? {address_parameters: output.addressParameters ?? output.address_parameters}
      : {}),
    asset_groups_count: tokenBundle?.length ?? 0,
    ...(inlineDatum ? {inline_datum_size: inlineDatum.length / 2} : {}),
    ...(referenceScript ? {reference_script_size: referenceScript.length / 2} : {}),
  }

  const outputResult = await session.typedCall('CardanoTxOutput', 'CardanoTxItemAck', outputData, signal)
  if (!outputResult.success) return outputResult

  // Send token bundle
  if (tokenBundle) {
    for (const assetGroup of tokenBundle) {
      const groupResult = await session.typedCall(
        'CardanoAssetGroup',
        'CardanoTxItemAck',
        {
          policy_id: assetGroup.policyId,
          tokens_count: assetGroup.tokenAmounts.length,
        },
        signal,
      )
      if (!groupResult.success) return groupResult

      for (const token of assetGroup.tokenAmounts) {
        const t = token as Record<string, unknown>
        const tokenResult = await session.typedCall(
          'CardanoToken',
          'CardanoTxItemAck',
          {
            asset_name_bytes: t.assetNameBytes ?? t.asset_name_bytes,
            ...(t.amount != null ? {amount: t.amount} : {}),
            ...(t.mintAmount != null
              ? {mint_amount: t.mintAmount}
              : t.mint_amount != null
                ? {mint_amount: t.mint_amount}
                : {}),
          },
          signal,
        )
        if (!tokenResult.success) return tokenResult
      }
    }
  }

  // Send inline datum chunks
  if (inlineDatum) {
    const datumResult = await sendChunkedHexData(session, inlineDatum, 'CardanoTxInlineDatumChunk', signal)
    if (!datumResult.success) return datumResult
  }

  // Send reference script chunks
  if (referenceScript) {
    const scriptResult = await sendChunkedHexData(session, referenceScript, 'CardanoTxReferenceScriptChunk', signal)
    if (!scriptResult.success) return scriptResult
  }

  return outputResult
}

/**
 * Cardano sign transaction request (for the multi-step protocol).
 */
export type CardanoSignTxParams = {
  readonly signingMode: number
  readonly protocolMagic: number
  readonly networkId: number
  readonly fee: string
  readonly ttl?: string | undefined
  readonly validityIntervalStart?: string | undefined
  readonly inputs: ReadonlyArray<Record<string, unknown>>
  readonly outputs: ReadonlyArray<Record<string, unknown>>
  readonly certificates?: ReadonlyArray<Record<string, unknown>> | undefined
  readonly withdrawals?: ReadonlyArray<Record<string, unknown>> | undefined
  readonly auxiliaryData?: Record<string, unknown> | undefined
  readonly auxiliaryDataHash?: string | undefined
  readonly mint?: ReadonlyArray<{policyId: string; tokenAmounts: ReadonlyArray<Record<string, unknown>>}> | undefined
  readonly scriptDataHash?: string | undefined
  readonly collateralInputs?: ReadonlyArray<Record<string, unknown>> | undefined
  readonly requiredSigners?: ReadonlyArray<Record<string, unknown>> | undefined
  readonly collateralReturn?: Record<string, unknown> | undefined
  readonly totalCollateral?: string | undefined
  readonly referenceInputs?: ReadonlyArray<Record<string, unknown>> | undefined
  readonly witnessPaths: ReadonlyArray<string | readonly number[]>
  readonly derivationType?: number | undefined
  readonly includeNetworkId?: boolean | undefined
  readonly tagCborSets?: boolean | undefined
}

/**
 * Cardano sign transaction result.
 */
export type CardanoSignTxResult = {
  readonly hash: string
  readonly witnesses: ReadonlyArray<{
    readonly type: string
    readonly pubKey: string
    readonly signature: string
    readonly chainCode?: string | undefined
  }>
  readonly auxiliaryDataSupplement?:
    | {
        readonly type: string
        readonly auxiliaryDataHash: string
        readonly cip36VoteRegistrationSignature?: string | undefined
      }
    | undefined
}

/**
 * Executes the Cardano multi-step signing protocol.
 *
 * Flow: Init → Inputs → Outputs → Certificates → Withdrawals →
 * AuxiliaryData → Mint → CollateralInputs → RequiredSigners →
 * CollateralReturn → ReferenceInputs → Witnesses → TxBodyHash → Finish
 */
export const cardanoSignTx = async (
  session: DeviceSession,
  params: CardanoSignTxParams,
  signal?: AbortSignal,
): Promise<Result<CardanoSignTxResult>> => {
  const {
    inputs,
    outputs,
    certificates,
    withdrawals,
    auxiliaryData,
    auxiliaryDataHash,
    mint,
    collateralInputs,
    requiredSigners,
    collateralReturn,
    totalCollateral,
    referenceInputs,
    witnessPaths,
  } = params

  // 1. Init
  const initResult = await session.typedCall(
    'CardanoSignTxInit',
    'CardanoTxItemAck',
    {
      signing_mode: params.signingMode,
      protocol_magic: params.protocolMagic,
      network_id: params.networkId,
      inputs_count: inputs.length,
      outputs_count: outputs.length,
      fee: params.fee,
      ttl: params.ttl,
      certificates_count: certificates?.length ?? 0,
      withdrawals_count: withdrawals?.length ?? 0,
      has_auxiliary_data: !!(auxiliaryData ?? auxiliaryDataHash),
      validity_interval_start: params.validityIntervalStart,
      witness_requests_count: witnessPaths.length,
      minting_asset_groups_count: mint?.length ?? 0,
      script_data_hash: params.scriptDataHash,
      collateral_inputs_count: collateralInputs?.length ?? 0,
      required_signers_count: requiredSigners?.length ?? 0,
      has_collateral_return: collateralReturn != null,
      total_collateral: totalCollateral,
      reference_inputs_count: referenceInputs?.length ?? 0,
      derivation_type: params.derivationType ?? 2, // ICARUS_TREZOR
      include_network_id: params.includeNetworkId ?? false,
      tag_cbor_sets: params.tagCborSets ?? false,
    },
    signal,
  )
  if (!initResult.success) return initResult

  // 2. Inputs
  for (const input of inputs) {
    const r = await session.typedCall('CardanoTxInput', 'CardanoTxItemAck', input, signal)
    if (!r.success) return r
  }

  // 3. Outputs (with token bundles, inline datums, reference scripts)
  for (const output of outputs) {
    const r = await sendCardanoOutput(session, output as Record<string, unknown>, signal)
    if (!r.success) return r
  }

  // 4. Certificates (with pool registration follow-up messages)
  if (certificates) {
    for (const cert of certificates) {
      const poolParams = cert.pool_parameters as
        | {
            owners: ReadonlyArray<Record<string, unknown>>
            relays: ReadonlyArray<Record<string, unknown>>
          }
        | undefined

      const certData = cert

      const r = await session.typedCall('CardanoTxCertificate', 'CardanoTxItemAck', certData, signal)
      if (!r.success) return r

      // Send pool registration follow-up messages
      if (poolParams) {
        for (const owner of poolParams.owners) {
          const or = await session.typedCall('CardanoPoolOwner', 'CardanoTxItemAck', owner, signal)
          if (!or.success) return or
        }
        for (const relay of poolParams.relays) {
          const rr = await session.typedCall('CardanoPoolRelayParameters', 'CardanoTxItemAck', relay, signal)
          if (!rr.success) return rr
        }
      }
    }
  }

  // 5. Withdrawals
  if (withdrawals) {
    for (const withdrawal of withdrawals) {
      const r = await session.typedCall('CardanoTxWithdrawal', 'CardanoTxItemAck', withdrawal, signal)
      if (!r.success) return r
    }
  }

  // 6. Auxiliary data
  let auxiliaryDataSupplement: CardanoSignTxResult['auxiliaryDataSupplement'] | undefined
  if (auxiliaryData) {
    const auxResult = await session.typedCall(
      'CardanoTxAuxiliaryData',
      'CardanoTxAuxiliaryDataSupplement',
      auxiliaryData,
      signal,
    )
    if (!auxResult.success) return auxResult

    const auxMessage = auxResult.payload.message
    const supplementType = auxMessage.type as string
    if (supplementType !== 'NONE') {
      auxiliaryDataSupplement = {
        type: supplementType,
        auxiliaryDataHash: auxMessage.auxiliary_data_hash as string,
        cip36VoteRegistrationSignature: auxMessage.cvote_registration_signature as string | undefined,
      }
    }

    // Host ack after aux data
    const hostAckResult = await session.typedCall('CardanoTxHostAck', 'CardanoTxItemAck', {}, signal)
    if (!hostAckResult.success) return hostAckResult
  } else if (auxiliaryDataHash) {
    const auxResult = await session.typedCall(
      'CardanoTxAuxiliaryData',
      'CardanoTxAuxiliaryDataSupplement',
      {hash: auxiliaryDataHash},
      signal,
    )
    if (!auxResult.success) return auxResult

    // Host ack after aux data
    const hostAckResult = await session.typedCall('CardanoTxHostAck', 'CardanoTxItemAck', {}, signal)
    if (!hostAckResult.success) return hostAckResult
  }

  // 7. Mint
  if (mint && mint.length > 0) {
    const mintInitResult = await session.typedCall(
      'CardanoTxMint',
      'CardanoTxItemAck',
      {asset_groups_count: mint.length},
      signal,
    )
    if (!mintInitResult.success) return mintInitResult

    for (const assetGroup of mint) {
      const groupResult = await session.typedCall(
        'CardanoAssetGroup',
        'CardanoTxItemAck',
        {
          policy_id: assetGroup.policyId,
          tokens_count: assetGroup.tokenAmounts.length,
        },
        signal,
      )
      if (!groupResult.success) return groupResult

      for (const token of assetGroup.tokenAmounts) {
        const t = token as Record<string, unknown>
        const tokenResult = await session.typedCall(
          'CardanoToken',
          'CardanoTxItemAck',
          {
            asset_name_bytes: t.assetNameBytes ?? t.asset_name_bytes,
            ...(t.amount != null ? {amount: t.amount} : {}),
            ...(t.mintAmount != null
              ? {mint_amount: t.mintAmount}
              : t.mint_amount != null
                ? {mint_amount: t.mint_amount}
                : {}),
          },
          signal,
        )
        if (!tokenResult.success) return tokenResult
      }
    }
  }

  // 8. Collateral inputs
  if (collateralInputs) {
    for (const input of collateralInputs) {
      const r = await session.typedCall('CardanoTxCollateralInput', 'CardanoTxItemAck', input, signal)
      if (!r.success) return r
    }
  }

  // 9. Required signers
  if (requiredSigners) {
    for (const signer of requiredSigners) {
      const r = await session.typedCall('CardanoTxRequiredSigner', 'CardanoTxItemAck', signer, signal)
      if (!r.success) return r
    }
  }

  // 10. Collateral return
  if (collateralReturn) {
    const r = await sendCardanoOutput(session, collateralReturn as Record<string, unknown>, signal)
    if (!r.success) return r
  }

  // 11. Reference inputs
  if (referenceInputs) {
    for (const input of referenceInputs) {
      const r = await session.typedCall('CardanoTxReferenceInput', 'CardanoTxItemAck', input, signal)
      if (!r.success) return r
    }
  }

  // 12. Witnesses
  const witnesses: CardanoSignTxResult['witnesses'][number][] = []
  for (const rawPath of witnessPaths) {
    // Convert string paths like "m/1852'/1815'/0'/0/0" to uint32 arrays with hardened flags
    const path = typeof rawPath === 'string' ? parsePathString(rawPath) : rawPath
    const witnessResult = await session.typedCall('CardanoTxWitnessRequest', 'CardanoTxWitnessResponse', {path}, signal)
    if (!witnessResult.success) return witnessResult

    const wMsg = witnessResult.payload.message
    witnesses.push({
      type: (wMsg.type as string) ?? 'SHELLEY',
      pubKey: wMsg.pub_key as string,
      signature: wMsg.signature as string,
      chainCode: wMsg.chain_code as string | undefined,
    })
  }

  // 13. Tx body hash
  const hashResult = await session.typedCall('CardanoTxHostAck', 'CardanoTxBodyHash', {}, signal)
  if (!hashResult.success) return hashResult

  const txHash = hashResult.payload.message.tx_hash as string

  // 14. Finish
  const finishResult = await session.typedCall('CardanoTxHostAck', 'CardanoSignTxFinished', {}, signal)
  if (!finishResult.success) return finishResult

  return ok({
    hash: txHash,
    witnesses,
    auxiliaryDataSupplement,
  })
}

// --- Bitcoin multi-step signing ---

/**
 * Bitcoin sign transaction via the TxRequest/TxAck loop.
 *
 * The device drives the signing process by sending TxRequest messages
 * with request_type indicating what data it needs next. The host responds
 * with the appropriate TxAck variant until TXFINISHED is received.
 */
/** Reference (previous) transaction data for non-SegWit verification. */
export type BitcoinRefTx = {
  readonly version: number
  readonly locktime: number
  readonly inputs: ReadonlyArray<{
    prev_hash: string
    prev_index: number
    script_sig: string
    sequence: number
  }>
  readonly bin_outputs: ReadonlyArray<{
    amount: string
    script_pubkey: string
  }>
  readonly extra_data?: string | undefined
}

export type BitcoinSignTxParams = {
  readonly inputs: ReadonlyArray<{
    address_n: readonly number[]
    prev_hash: string
    prev_index: number
    amount: string
    script_type?: string
    sequence?: number
    orig_hash?: string
    orig_index?: number
  }>
  readonly outputs: ReadonlyArray<{
    address?: string
    address_n?: readonly number[]
    amount: string
    script_type?: string
    orig_hash?: string
    orig_index?: number
  }>
  readonly coin?: string | undefined
  readonly version?: number | undefined
  readonly locktime?: number | undefined
  readonly push?: boolean | undefined
  /** Previous transactions for non-SegWit input verification. Keyed by tx hash. */
  readonly refTxs?: ReadonlyMap<string, BitcoinRefTx> | undefined
  /**
   * Use the legacy universal TxAck flow. When false, prefer the more explicit
   * TxAckInput/Output/Prev* messages used by newer firmware.
   */
  readonly useLegacySignProcess?: boolean | undefined
}

export type BitcoinSignTxResult = {
  readonly serializedTx: string
  readonly signatures: readonly string[]
}

const hasPrevTxExtraData = (refTx: BitcoinRefTx): refTx is BitcoinRefTx & {readonly extra_data: string} =>
  typeof refTx.extra_data === 'string' && refTx.extra_data.length > 0

const buildLegacyPrevTxMeta = (refTx: BitcoinRefTx) => ({
  version: refTx.version,
  lock_time: refTx.locktime,
  inputs_cnt: refTx.inputs.length,
  outputs_cnt: refTx.bin_outputs.length,
  ...(hasPrevTxExtraData(refTx) ? {extra_data_len: refTx.extra_data.length / 2} : {}),
})

const buildModernPrevTxMeta = (refTx: BitcoinRefTx) => ({
  version: refTx.version,
  lock_time: refTx.locktime,
  inputs_count: refTx.inputs.length,
  outputs_count: refTx.bin_outputs.length,
  ...(hasPrevTxExtraData(refTx) ? {extra_data_len: refTx.extra_data.length / 2} : {}),
})

/**
 * Executes the Bitcoin multi-step signing protocol.
 *
 * The device issues TxRequest messages asking for specific inputs/outputs.
 * We respond with TxAck messages containing the requested data.
 */
export const bitcoinSignTx = async (
  session: DeviceSession,
  params: BitcoinSignTxParams,
  signal?: AbortSignal,
): Promise<Result<BitcoinSignTxResult>> => {
  const {inputs, outputs, refTxs} = params
  const useLegacySignProcess = params.useLegacySignProcess ?? true

  // Initial SignTx call
  const initResult = await session.typedCall(
    'SignTx',
    'TxRequest',
    {
      inputs_count: inputs.length,
      outputs_count: outputs.length,
      coin_name: params.coin ?? 'Bitcoin',
      version: params.version ?? 1,
      lock_time: params.locktime ?? 0,
    },
    signal,
  )
  if (!initResult.success) return initResult

  const signatures: string[] = []
  const serializedTxParts: string[] = []

  // Process TxRequest loop
  let txRequest = initResult.payload.message

  while (true) {
    // Collect any serialized data from the response
    const serialized = txRequest.serialized as
      | {signature_index?: number; signature?: string; serialized_tx?: string}
      | undefined
    if (serialized) {
      if (serialized.signature !== undefined && serialized.signature_index !== undefined) {
        signatures[serialized.signature_index] = serialized.signature
      }
      if (serialized.serialized_tx) {
        serializedTxParts.push(serialized.serialized_tx)
      }
    }

    const requestType = txRequest.request_type as string

    if (requestType === 'TXFINISHED') {
      return ok({
        serializedTx: serializedTxParts.join(''),
        signatures,
      })
    }

    const details = txRequest.details as
      | {request_index?: number; tx_hash?: string; extra_data_offset?: number; extra_data_len?: number}
      | undefined
    const requestIndex = details?.request_index ?? 0
    const txHash = details?.tx_hash

    let ackResult: Result<MessageResponse>

    switch (requestType) {
      case 'TXINPUT': {
        if (txHash) {
          // Firmware is asking for an input from a previous transaction
          const refTx = refTxs?.get(txHash)
          if (!refTx) return fail('Failure_DataError', `Reference transaction ${txHash} not found`)
          const refInput = refTx.inputs[requestIndex]
          if (!refInput) return fail('Failure_DataError', `Ref tx ${txHash} input ${requestIndex} out of range`)
          ackResult = useLegacySignProcess
            ? await session.typedCall('TxAck', 'TxRequest', {tx: {inputs: [refInput]}}, signal)
            : await session.typedCall('TxAckPrevInput', 'TxRequest', {tx: {input: refInput}}, signal)
        } else {
          const input = inputs[requestIndex]
          if (!input) return fail('Failure_DataError', `Input index ${requestIndex} out of range`)
          ackResult = useLegacySignProcess
            ? await session.typedCall('TxAck', 'TxRequest', {tx: {inputs: [input]}}, signal)
            : await session.typedCall('TxAckInput', 'TxRequest', {tx: {input}}, signal)
        }
        break
      }

      case 'TXOUTPUT': {
        if (txHash) {
          // Firmware is asking for an output from a previous transaction (bin_output format)
          const refTx = refTxs?.get(txHash)
          if (!refTx) return fail('Failure_DataError', `Reference transaction ${txHash} not found`)
          const refOutput = refTx.bin_outputs[requestIndex]
          if (!refOutput) return fail('Failure_DataError', `Ref tx ${txHash} output ${requestIndex} out of range`)
          ackResult = useLegacySignProcess
            ? await session.typedCall('TxAck', 'TxRequest', {tx: {bin_outputs: [refOutput]}}, signal)
            : await session.typedCall('TxAckPrevOutput', 'TxRequest', {tx: {output: refOutput}}, signal)
        } else {
          const output = outputs[requestIndex]
          if (!output) return fail('Failure_DataError', `Output index ${requestIndex} out of range`)
          ackResult = useLegacySignProcess
            ? await session.typedCall('TxAck', 'TxRequest', {tx: {outputs: [output]}}, signal)
            : await session.typedCall('TxAckOutput', 'TxRequest', {tx: {output}}, signal)
        }
        break
      }

      case 'TXMETA': {
        // Firmware is asking for metadata of a previous transaction
        if (!txHash) return fail('Failure_DataError', 'TXMETA without tx_hash')
        const refTx = refTxs?.get(txHash)
        if (!refTx) return fail('Failure_DataError', `Reference transaction ${txHash} not found`)
        ackResult = useLegacySignProcess
          ? await session.typedCall('TxAck', 'TxRequest', {tx: buildLegacyPrevTxMeta(refTx)}, signal)
          : await session.typedCall('TxAckPrevMeta', 'TxRequest', {tx: buildModernPrevTxMeta(refTx)}, signal)
        break
      }

      case 'TXEXTRADATA': {
        // Firmware is asking for a slice of extra_data from a previous transaction
        if (!txHash) return fail('Failure_DataError', 'TXEXTRADATA without tx_hash')
        const refTx = refTxs?.get(txHash)
        if (!refTx) return fail('Failure_DataError', `Reference transaction ${txHash} not found`)
        const extraData = refTx.extra_data ?? ''
        const offset = (details?.extra_data_offset ?? 0) * 2
        const len = (details?.extra_data_len ?? 0) * 2
        ackResult = useLegacySignProcess
          ? await session.typedCall(
              'TxAck',
              'TxRequest',
              {tx: {extra_data_chunk: extraData.slice(offset, offset + len)}},
              signal,
            )
          : await session.typedCall(
              'TxAckPrevExtraData',
              'TxRequest',
              {tx: {extra_data_chunk: extraData.slice(offset, offset + len)}},
              signal,
            )
        break
      }

      case 'TXORIGINPUT': {
        // Firmware is asking for an original input (for RBF replacement transactions)
        const input = inputs[requestIndex]
        if (!input) return fail('Failure_DataError', `Original input index ${requestIndex} out of range`)
        ackResult = useLegacySignProcess
          ? await session.typedCall('TxAck', 'TxRequest', {tx: {inputs: [input]}}, signal)
          : await session.typedCall('TxAckInput', 'TxRequest', {tx: {input}}, signal)
        break
      }

      case 'TXORIGOUTPUT': {
        // Firmware is asking for an original output (for RBF replacement transactions)
        const output = outputs[requestIndex]
        if (!output) return fail('Failure_DataError', `Original output index ${requestIndex} out of range`)
        ackResult = useLegacySignProcess
          ? await session.typedCall('TxAck', 'TxRequest', {tx: {outputs: [output]}}, signal)
          : await session.typedCall('TxAckOutput', 'TxRequest', {tx: {output}}, signal)
        break
      }

      default:
        return fail('Failure_UnexpectedMessage', `Unhandled TxRequest type: ${requestType}`)
    }

    if (!ackResult.success) return ackResult
    txRequest = ackResult.payload.message
  }
}

// --- Ethereum signing ---

/** Strip leading zero bytes from hex string for protobuf bytes fields. "0000" -> "", "0x000123" -> "0123" */
const stripLeadingZeroes = (hex: string): string => {
  let clean = hex.replace(/^0x/i, '')
  // Pad to even length first to preserve byte boundaries
  if (clean.length % 2 !== 0) clean = `0${clean}`
  // Strip whole zero bytes (pairs of "00"), not individual hex chars
  while (clean.startsWith('00') && clean.length > 0) {
    clean = clean.slice(2)
  }
  return clean
}

/**
 * Signs an Ethereum transaction, handling data chunking.
 */
export const ethereumSignTx = async (
  session: DeviceSession,
  params: {
    address_n: readonly number[]
    to: string
    value: string
    gas_limit: string
    gas_price?: string | undefined
    max_fee_per_gas?: string | undefined
    max_priority_fee_per_gas?: string | undefined
    nonce: string
    chain_id: number
    data?: string | undefined
    definitions?: {encoded_network?: string; encoded_token?: string} | undefined
  },
  signal?: AbortSignal,
): Promise<Result<{v: string; r: string; s: string}>> => {
  const txData = (params.data ?? '').replace(/^0x/i, '')
  const dataLength = txData.length / 2
  const INITIAL_CHUNK_SIZE_HEX = 2048 // 1024 bytes = 2048 hex chars

  const dataInitialChunk = txData.slice(0, INITIAL_CHUNK_SIZE_HEX)
  let remainingData = txData.slice(INITIAL_CHUNK_SIZE_HEX)

  // Choose message type based on EIP-1559 fields
  const isEIP1559 = params.max_fee_per_gas !== undefined

  const messageName = isEIP1559 ? 'EthereumSignTxEIP1559' : 'EthereumSignTx'
  const messageData: Record<string, unknown> = {
    address_n: params.address_n,
    chain_id: params.chain_id,
    nonce: stripLeadingZeroes(params.nonce),
    gas_limit: stripLeadingZeroes(params.gas_limit),
    to: params.to,
    value: stripLeadingZeroes(params.value),
  }

  if (isEIP1559) {
    messageData.max_gas_fee = stripLeadingZeroes(params.max_fee_per_gas ?? '0')
    messageData.max_priority_fee = stripLeadingZeroes(params.max_priority_fee_per_gas ?? '0')
  } else {
    messageData.gas_price = stripLeadingZeroes(params.gas_price ?? '0')
  }

  // External definitions for token/network display on device
  if (params.definitions) {
    messageData.definitions = params.definitions
  }

  // Always send data_length (required for EIP-1559, expected by firmware for legacy)
  messageData.data_length = dataLength
  if (dataLength > 0) {
    messageData.data_initial_chunk = dataInitialChunk
  }

  let result = await session.typedCall(messageName, 'EthereumTxRequest', messageData, signal)

  // Data chunking loop
  while (result.success) {
    const msg = result.payload.message
    const requestedLength = msg.data_length as number | undefined

    if (!requestedLength || remainingData.length === 0) {
      // Signature is ready — recompute v for EIP-155 replay protection on legacy txs
      let v = (msg.signature_v as number) ?? 0
      if (!isEIP1559 && v <= 1) {
        v = v + 2 * params.chain_id + 35
      }
      return ok({
        v: `0x${v.toString(16)}`,
        r: `0x${msg.signature_r as string}`,
        s: `0x${msg.signature_s as string}`,
      })
    }

    // Send the exact number of bytes the firmware requested
    const chunkSizeHex = requestedLength * 2
    const chunk = remainingData.slice(0, chunkSizeHex)
    remainingData = remainingData.slice(chunkSizeHex)

    result = await session.typedCall('EthereumTxAck', 'EthereumTxRequest', {data_chunk: chunk}, signal)
  }

  return result
}

// --- EIP-712 typed data signing ---

// Regex patterns for EIP-712 type parsing (from EIP-712 / Solidity ABI spec)
const paramTypeArray = /^(.*)\[([0-9]*)\]$/
const paramTypeBytes = /^bytes([0-9]*)$/
const paramTypeNumber = /^(u?int)([0-9]*)$/

/** Simple type name → Trezor EthereumDataType mapping */
const simpleTypeMap: Record<string, string> = {
  string: 'STRING',
  bool: 'BOOL',
  address: 'ADDRESS',
}

/**
 * EIP-712 typed data types definition.
 * Maps type names to arrays of {name, type} field descriptors.
 */
export type EIP712Types = Record<string, ReadonlyArray<{readonly name: string; readonly type: string}>>

type EthereumFieldType = {
  data_type: string
  size?: number | undefined
  entry_type?: EthereumFieldType | undefined
  struct_name?: string | undefined
}

/**
 * Converts an EIP-712 type name to the Trezor EthereumFieldType protobuf format.
 */
const getFieldType = (typeName: string, types: EIP712Types): EthereumFieldType => {
  // Array type: "uint256[]" or "uint256[32]"
  const arrayMatch = paramTypeArray.exec(typeName)
  if (arrayMatch) {
    const [, entryTypeName = '', arraySize] = arrayMatch
    return {
      data_type: 'ARRAY',
      size: arraySize ? parseInt(arraySize, 10) : undefined,
      entry_type: getFieldType(entryTypeName, types),
    }
  }

  // Numeric type: "uint256", "int8"
  const numberMatch = paramTypeNumber.exec(typeName)
  if (numberMatch) {
    const [, intType = 'uint', bits = '256'] = numberMatch
    return {
      data_type: intType === 'uint' ? 'UINT' : 'INT',
      size: Math.floor(parseInt(bits, 10) / 8),
    }
  }

  // Bytes type: "bytes32" or "bytes" (dynamic)
  const bytesMatch = paramTypeBytes.exec(typeName)
  if (bytesMatch) {
    const [, size] = bytesMatch
    return {
      data_type: 'BYTES',
      size: size ? parseInt(size, 10) : undefined,
    }
  }

  // Simple types: string, bool, address
  const simple = simpleTypeMap[typeName]
  if (simple) return {data_type: simple}

  // Struct type: custom name present in types map
  const typeDefinition = types[typeName]
  if (typeDefinition) {
    return {
      data_type: 'STRUCT',
      size: typeDefinition.length,
      struct_name: typeName,
    }
  }

  throw new Error(`EIP-712: No type definition for "${typeName}"`)
}

/**
 * Two's complement for signed integers.
 */
const twosComplement = (value: bigint, bytes: number): bigint => {
  const bits = BigInt(bytes * 8)
  const minValue = -(1n << (bits - 1n))
  const maxValue = (1n << (bits - 1n)) - 1n
  if (value > maxValue || value < minValue) {
    throw new Error(`Overflow converting ${value} into ${bytes} bytes`)
  }
  if (value >= 0n) return value
  return value - minValue - minValue
}

/**
 * Encodes a primitive EIP-712 value to a big-endian hex string for Trezor.
 */
const encodeData = (typeName: string, data: unknown): string => {
  // bytes* or address — hex data
  if (paramTypeBytes.test(typeName) || typeName === 'address') {
    let hex = String(data)
    if (hex.startsWith('0x') || hex.startsWith('0X')) hex = hex.slice(2)
    if (hex.length % 2 !== 0) hex = `0${hex}`
    return hex
  }

  // string — UTF-8 encode
  if (typeName === 'string') {
    return bytesToHex(utf8ToBytes(String(data)))
  }

  // uint* / int*
  const numberMatch = paramTypeNumber.exec(typeName)
  if (numberMatch) {
    const [, intType = 'uint', bits = '256'] = numberMatch
    const bytes = Math.ceil(parseInt(bits, 10) / 8)
    const signed = intType === 'int'
    let bigValue = BigInt(data as string | number | bigint)
    if (signed) bigValue = twosComplement(bigValue, bytes)
    if (bigValue < 0n) throw new Error(`Cannot convert negative number to unsigned integer: ${data}`)
    const hex = bigValue.toString(16)
    if (hex.length > bytes * 2) throw new Error(`Overflow converting ${data} into ${bytes} bytes`)
    return hex.padStart(bytes * 2, '0')
  }

  // bool
  if (typeName === 'bool') return data ? '01' : '00'

  throw new Error(`EIP-712: Unsupported primitive type for encoding: ${typeName}`)
}

/**
 * Parse array type syntax: "uint256[32]" → {entryTypeName: "uint256", arraySize: 32}
 */
const parseArrayType = (typeName: string): {entryTypeName: string; arraySize: number | null} => {
  const match = paramTypeArray.exec(typeName)
  if (!match) throw new Error(`EIP-712: "${typeName}" is not an array type`)
  const [, entryTypeName = '', arraySize] = match
  return {
    entryTypeName,
    arraySize: arraySize ? parseInt(arraySize, 10) : null,
  }
}

/**
 * Signs EIP-712 typed data using the multi-round Trezor protocol.
 *
 * Protocol flow:
 * 1. Send EthereumSignTypedData with primary_type
 * 2. Device requests struct definitions → respond with EthereumTypedDataStructAck
 * 3. Device requests values by member_path → respond with EthereumTypedDataValueAck
 * 4. Device returns EthereumTypedDataSignature
 */
export const ethereumSignTypedData = async (
  session: DeviceSession,
  params: {
    address_n: readonly number[]
    data: {
      types: EIP712Types
      primaryType: string
      domain: Record<string, unknown>
      message: Record<string, unknown>
    }
    metamask_v4_compat?: boolean
  },
  signal?: AbortSignal,
): Promise<Result<{signature: string; address: string}>> => {
  const {types, primaryType, domain, message} = params.data

  // 1. Initiate — device will start requesting struct definitions
  let result = await session.typedCall(
    'EthereumSignTypedData',
    ['EthereumTypedDataStructRequest', 'EthereumTypedDataValueRequest', 'EthereumTypedDataSignature'],
    {
      address_n: params.address_n,
      primary_type: primaryType,
      metamask_v4_compat: params.metamask_v4_compat ?? true,
    },
    signal,
  )
  if (!result.success) return result

  // 2. Struct definition exchange loop
  while (result.payload.type === 'EthereumTypedDataStructRequest') {
    const typeDefinitionName = result.payload.message.name as string
    const typeDefinition = types[typeDefinitionName]
    if (!typeDefinition) {
      return fail('EIP712_TYPE_ERROR', `Type "${typeDefinitionName}" was not defined in types object`)
    }

    const members = typeDefinition.map(({name, type: typeName}) => ({
      type: getFieldType(typeName, types),
      name,
    }))

    result = await session.typedCall(
      'EthereumTypedDataStructAck',
      ['EthereumTypedDataStructRequest', 'EthereumTypedDataValueRequest', 'EthereumTypedDataSignature'],
      {members},
      signal,
    )
    if (!result.success) return result
  }

  // 3. Value exchange loop
  while (result.payload.type === 'EthereumTypedDataValueRequest') {
    const memberPath = result.payload.message.member_path as number[]
    const [rootIndex, ...nestedPath] = memberPath

    let memberData: unknown
    let memberTypeName: string

    if (rootIndex === 0) {
      memberData = domain
      memberTypeName = 'EIP712Domain'
    } else if (rootIndex === 1) {
      memberData = message
      memberTypeName = primaryType
    } else {
      return fail('EIP712_PATH_ERROR', `Root index can only be 0 or 1, got ${rootIndex}`)
    }

    // Navigate nested path
    for (const index of nestedPath) {
      if (Array.isArray(memberData)) {
        memberTypeName = parseArrayType(memberTypeName).entryTypeName
        memberData = memberData[index]
      } else if (typeof memberData === 'object' && memberData !== null) {
        const memberTypeDefinition = types[memberTypeName]?.[index]
        if (!memberTypeDefinition) {
          return fail('EIP712_PATH_ERROR', `No type definition for ${memberTypeName}[${index}]`)
        }
        memberTypeName = memberTypeDefinition.type
        memberData = (memberData as Record<string, unknown>)[memberTypeDefinition.name]
      }
      if (memberData === null || memberData === undefined) {
        return fail('EIP712_VALUE_ERROR', `Value at member path [${memberPath.join(', ')}] is missing`)
      }
    }

    // Encode: arrays send their length as uint16, primitives send their value
    let encodedData: string
    if (Array.isArray(memberData)) {
      encodedData = encodeData('uint16', memberData.length)
    } else {
      encodedData = encodeData(memberTypeName, memberData)
    }

    result = await session.typedCall(
      'EthereumTypedDataValueAck',
      ['EthereumTypedDataValueRequest', 'EthereumTypedDataSignature'],
      {value: encodedData},
      signal,
    )
    if (!result.success) return result
  }

  // 4. Final signature
  const {address, signature} = result.payload.message as {address: string; signature: string}
  return ok({
    address,
    signature: signature.startsWith('0x') ? signature : `0x${signature}`,
  })
}

// --- Solana signing ---

/**
 * Signs a Solana transaction (single round-trip).
 */
export const solanaSignTx = async (
  session: DeviceSession,
  params: {
    address_n: readonly number[]
    serialized_tx: string
    additional_info?: {
      token_accounts_infos?: Array<{
        base_address: string
        token_program: string
        token_mint: string
        token_account: string
      }>
      encoded_token?: string
    }
  },
  signal?: AbortSignal,
): Promise<Result<{signature: string}>> => {
  const result = await session.typedCall('SolanaSignTx', 'SolanaTxSignature', params, signal)
  if (!result.success) return result

  return ok({signature: result.payload.message.signature as string})
}
