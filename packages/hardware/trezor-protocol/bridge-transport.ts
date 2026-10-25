/**
 * Bridge-based HTTP transport adapter for E2E testing.
 *
 * Communicates with trezord-go (Trezor bridge daemon) over HTTP to talk
 * to the Trezor emulator. This replaces the @trezor/connect dependency
 * in E2E tests.
 *
 * Trezor HTTP bridge API (default port **21328** — trezor-user-env node bridge):
 * - POST /enumerate — list connected devices
 * - POST /acquire/<path>/<previous> — acquire device session
 * - POST /release/<session> — release device session
 * - POST /call/<session> — send/receive protobuf message
 *
 * @module
 */

import {bytesToHex, hexToBytes, readUint16BE, readUint32BE, writeUint16BE, writeUint32BE} from './bytes'
import messagesJson from './messages.json' with {type: 'json'}
import type {MessageResponse} from './protobuf'
import {decodeMessage, encodeMessage, loadDefinitions, parseConfigure} from './protobuf'

// --- Result types ---

type Success<T> = {readonly success: true; readonly payload: T}
type ErrorResult = {readonly success: false; readonly error: string; readonly message?: string | undefined}
type Result<T> = Success<T> | ErrorResult

const ok = <T>(payload: T): Success<T> => ({success: true, payload})
const fail = (err: string, message?: string): ErrorResult => ({success: false, error: err, message})

// --- Bridge device descriptor ---

/**
 * Device descriptor returned by the bridge's /enumerate endpoint.
 */
export type BridgeDeviceDescriptor = {
  readonly path: string
  readonly vendor: number
  readonly product: number
  readonly session: string | null
  readonly debug: boolean
  readonly debugSession: string | null
}

// --- Configuration ---

export type BridgeTransportConfig = {
  /** Bridge URL (default: http://127.0.0.1:21328) */
  readonly url?: string
  /** Request timeout in milliseconds (default: 30000) */
  readonly timeout?: number
}

// --- Bridge transport ---

/**
 * Creates a bridge-based transport adapter for E2E testing.
 *
 * The returned adapter implements the TransportAdapter interface expected
 * by device-session.ts, allowing createTrezorDevice to work with the
 * Trezor bridge daemon directly — no @trezor/connect needed.
 */
export const createBridgeTransport = (config: BridgeTransportConfig = {}) => {
  const baseUrl = config.url ?? 'http://127.0.0.1:21328'
  const timeout = config.timeout ?? 30000

  // Protobuf root for encoding/decoding messages — pre-loaded with Trezor definitions
  let messages = parseConfigure(messagesJson as import('protobufjs').INamespace)

  const decoder = new TextDecoder()

  /**
   * Perform an HTTP POST to the bridge.
   */
  const bridgePost = async (
    path: string,
    body?: string,
    signal?: AbortSignal,
  ): Promise<{status: number; body: Uint8Array}> => {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeout)

    // Merge external signal with timeout
    if (signal) {
      signal.addEventListener('abort', () => controller.abort())
      if (signal.aborted) controller.abort()
    }

    try {
      const response = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: {Origin: 'https://wallet.trezor.io'},
        body: body ?? '',
        signal: controller.signal,
      })

      const arrayBuffer = await response.arrayBuffer()
      return {
        status: response.status,
        body: new Uint8Array(arrayBuffer),
      }
    } finally {
      clearTimeout(timeoutId)
    }
  }

  const bodyToString = (body: Uint8Array): string => decoder.decode(body)

  /**
   * Enumerate connected devices via the bridge.
   */
  const enumerate = async (params?: {signal?: AbortSignal}): Promise<BridgeDeviceDescriptor[]> => {
    const response = await bridgePost('/enumerate', undefined, params?.signal)
    return JSON.parse(bodyToString(response.body)) as BridgeDeviceDescriptor[]
  }

  /**
   * Acquire a session on a device.
   */
  const acquire = async (params: {
    input: {path: string; previous: string | null}
    signal?: AbortSignal
  }): Promise<Result<string>> => {
    const {path, previous} = params.input

    const tryAcquire = async (prev: string): Promise<{status: number; bodyText: string}> => {
      const response = await bridgePost(`/acquire/${path}/${prev}`, undefined, params.signal)
      return {status: response.status, bodyText: bodyToString(response.body)}
    }

    try {
      let result = await tryAcquire(previous ?? 'null')

      // The bridge rejects acquire when `previous` doesn't match the session it
      // currently holds for the device (a stale session left by a prior connect
      // that never released). Recover by re-enumerating to read the device's
      // actual current session and retrying once with it as `previous`.
      if (result.status === 400 && result.bodyText.includes('wrong previous session')) {
        const descriptors = await enumerate(params.signal ? {signal: params.signal} : undefined)
        const current = descriptors.find((d) => d.path === path)?.session
        if (current) result = await tryAcquire(current)
      }

      if (result.status !== 200) {
        return fail('AcquireFailed', `Bridge returned status ${result.status}: ${result.bodyText}`)
      }

      const parsed = JSON.parse(result.bodyText) as {session: string}
      return ok(parsed.session)
    } catch (e) {
      return fail('AcquireFailed', e instanceof Error ? e.message : String(e))
    }
  }

  /**
   * Release a device session.
   */
  const release = async (params: {path: string; session: string; signal?: AbortSignal}): Promise<Result<undefined>> => {
    try {
      const response = await bridgePost(`/release/${params.session}`, undefined, params.signal)

      if (response.status !== 200) {
        return fail('ReleaseFailed', `Bridge returned status ${response.status}: ${bodyToString(response.body)}`)
      }

      return ok(undefined)
    } catch (e) {
      return fail('ReleaseFailed', e instanceof Error ? e.message : String(e))
    }
  }

  /**
   * Send a protobuf message and receive a response via the bridge.
   *
   * The node-bridge /call endpoint expects a JSON BridgeProtocolMessage body:
   * `{protocol, data, thpState?}` where `data` is the hex-encoded frame
   * messageType(uint16BE) + length(uint32BE) + protobuf payload (no v1 0x3f ##
   * magic). That bare frame is the `bridge` protocol, so `protocol` is `'bridge'`
   * (the bridge re-encodes to v1 for the device wire itself). The response is the
   * same JSON envelope; unwrap `data` before decoding.
   */
  const call = async (params: {
    session: string
    name: string
    data: Record<string, unknown>
    signal?: AbortSignal | undefined
    timeout?: number | undefined
    protocol?: 'v1' | 'v2' | undefined
    thpState?: unknown
  }): Promise<Result<MessageResponse> | ErrorResult> => {
    try {
      // Encode the outgoing protobuf message
      const {messageType, message} = encodeMessage(messages, params.name, params.data)

      // Frame for bridge: type(uint16BE) + length(uint32BE) + protobuf payload
      const frame = new Uint8Array(6 + message.length)
      writeUint16BE(frame, messageType, 0)
      writeUint32BE(frame, message.length, 2)
      frame.set(message, 6)
      const hexBody = bytesToHex(frame)

      // Wrap as a BridgeProtocolMessage JSON envelope. The bare type+len+payload
      // frame is the `bridge` protocol; THP messages carry their own `thpState`.
      const wireProtocol = params.protocol === 'v2' ? 'v2' : 'bridge'
      const requestBody = JSON.stringify({protocol: wireProtocol, data: hexBody, thpState: params.thpState})

      // Send to bridge
      const response = await bridgePost(`/call/${params.session}`, requestBody, params.signal)

      if (response.status !== 200) {
        return fail('CallFailed', `Bridge returned status ${response.status}: ${bodyToString(response.body)}`)
      }

      // Unwrap the JSON envelope, then parse the hex frame: type(uint16BE) + length(uint32BE) + protobuf
      const {data: responseHex} = JSON.parse(bodyToString(response.body)) as {data: string}
      const responseBuffer = hexToBytes(responseHex)
      const respType = readUint16BE(responseBuffer, 0)
      const respLength = readUint32BE(responseBuffer, 2)
      const respPayload = responseBuffer.subarray(6, 6 + respLength)

      // Decode the protobuf message
      const decodedMessage = decodeMessage(messages, respType, respPayload)

      return ok(decodedMessage)
    } catch (e) {
      return fail('CallFailed', e instanceof Error ? e.message : String(e))
    }
  }

  /**
   * Update the protobuf message definitions.
   */
  const updateMessages = (msgs: unknown): void => {
    messages = parseConfigure(msgs as import('protobufjs').INamespace)
  }

  /**
   * Load additional protobuf definitions.
   */
  const loadMessages = async (packageName: string, packageLoader: () => unknown): Promise<void> => {
    await loadDefinitions(messages, packageName, packageLoader as () => import('protobufjs').INamespace)
  }

  return {
    enumerate,
    acquire,
    release,
    call,
    updateMessages,
    loadMessages,
  }
}
