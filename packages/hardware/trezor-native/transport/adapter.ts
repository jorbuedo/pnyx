/**
 * Transport adapter for native Trezor transports.
 *
 * Replaces @trezor/transport's AbstractTransport + AbstractApiTransport class
 * hierarchy with a factory function. Produces a duck-typed object that passes
 * `@trezor/connect`'s `isTransportInstance()` validation.
 *
 * Uses trezor-protocol/ for message encoding/decoding, protocol handling,
 * chunking, and transport utilities.
 */

import type * as protobuf from 'protobufjs'
import {bytesToHex} from '../../trezor-protocol/bytes'
import {
  ACTION_TIMEOUT,
  buildMessage,
  createChunks,
  decodeMessage,
  ERRORS,
  encodeMessage,
  loadDefinitions,
  parseConfigure,
  receiveAndParse,
  sendChunks,
  TRANSPORT,
  thp,
  v1,
} from '../../trezor-protocol/index'
import messagesJson from '../../trezor-protocol/messages.json' with {type: 'json'}
import {getSynchronize, scheduleAction} from '../../trezor-protocol/utils'
import {createEventEmitter} from '../event-emitter'

import {handleDescriptorsChange} from './descriptors'
import {createSessionsState} from './sessions'
import type {Descriptor, DeviceApi, ErrorResult, Logger} from './types'
import {error, success, unknownError} from './types'

type ProtobufMessages = protobuf.INamespace

// Protocol discriminant: 'v1' (legacy) or 'v2' (THP)
type TransportProtocol = 'v1' | 'v2'

export type TransportAdapterParams = {
  readonly name: string
  readonly api: DeviceApi
  readonly logger?: Logger | undefined
  readonly messages?: ProtobufMessages | undefined
  readonly id?: string | undefined
}

export const createTransportAdapter = (params: TransportAdapterParams) => {
  const {name, api, logger, id} = params
  const emitter = createEventEmitter()
  const deviceEventsEmitter = createEventEmitter()
  const sessions = createSessionsState()
  let messages = parseConfigure((params.messages ?? messagesJson) as protobuf.INamespace)
  let stopped = true
  let listening = false
  let descriptors: Descriptor[] = []
  const abortController = new AbortController()

  // --- Result helpers ---

  const mergeAbort = (signal?: AbortSignal) => {
    if (!signal) {
      return {signal: abortController.signal, clear: () => {}}
    }
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    signal.addEventListener('abort', onAbort)
    if (signal.aborted) controller.abort(signal.reason)
    abortController.signal.addEventListener('abort', onAbort)
    const clear = () => {
      signal.removeEventListener('abort', onAbort)
      abortController.signal.removeEventListener('abort', onAbort)
    }
    return {signal: controller.signal, clear}
  }

  const scheduleTransportAction = <T>(
    action: (signal: AbortSignal) => Promise<T>,
    actionParams?: {signal?: AbortSignal | undefined; graceful?: boolean | undefined; timeout?: number | undefined},
    errors: string[] = [],
  ): Promise<T | ErrorResult> => {
    const {signal, clear} = mergeAbort(actionParams?.signal)
    return scheduleAction(action, {
      timeout: actionParams?.timeout ?? ACTION_TIMEOUT,
      graceful: actionParams?.graceful,
      signal,
    })
      .catch((err: Error) => unknownError(err, [ERRORS.ABORTED_BY_TIMEOUT, ERRORS.ABORTED_BY_SIGNAL, ...errors]))
      .finally(clear)
  }

  // --- THP call serialization ---

  // THP (v2) reads sendNonce at encode time and advances it only after the device
  // round-trip completes, so two overlapping calls on the same channel would
  // encrypt under the same AES-GCM (key, IV) → nonce reuse. Upstream trezor-suite
  // avoids this by serializing all requests to a device at the connect layer; we
  // enforce it here at the transport with a per-thpState lock, so encode →
  // round-trip → syncState is atomic per channel while distinct channels/devices
  // still run concurrently.
  const thpLocks = new WeakMap<thp.ThpState, <T>(action: () => Promise<T>) => Promise<T>>()
  const withThpSerialization = <T>(
    protocol: TransportProtocol | undefined,
    thpState: thp.ThpState | undefined,
    exec: () => Promise<T>,
  ): Promise<T> => {
    if (protocol !== 'v2' || !thpState) return exec()
    let synchronize = thpLocks.get(thpState)
    if (!synchronize) {
      synchronize = getSynchronize(logger)
      thpLocks.set(thpState, synchronize)
    }
    return synchronize(exec)
  }

  // --- Transport methods ---

  const init = (initParams?: {signal?: AbortSignal}) =>
    scheduleTransportAction(async () => {
      const handshakeRes = sessions.handshake()
      stopped = !handshakeRes.success
      return handshakeRes
    }, initParams)

  const listen = () => {
    if (listening) {
      return error(ERRORS.ALREADY_LISTENING)
    }
    api.listen()
    listening = true

    api.on('transport-interface-change', (...args: unknown[]) => {
      const apiDescriptors = args[0]
      logger?.debug('new descriptors from api', apiDescriptors)
      sessions.enumerateDone({descriptors: apiDescriptors as Descriptor[]})
    })

    sessions.on('descriptors', (...args: unknown[]) => {
      const sessionDescriptors = args[0] as Descriptor[]
      logger?.debug('new descriptors from background', sessionDescriptors)
      if (!stopped) {
        descriptors = handleDescriptorsChange(descriptors, sessionDescriptors, emitter, deviceEventsEmitter)
      }
    })

    return success(undefined)
  }

  const enumerate = (enumerateParams?: {signal?: AbortSignal}) =>
    scheduleTransportAction(async (signal: AbortSignal) => {
      const enumerateResult = await api.enumerate(signal)
      if (!enumerateResult.success) return enumerateResult

      const enumerateDoneResponse = await sessions.enumerateDone({
        descriptors: enumerateResult.payload,
      })
      return success(enumerateDoneResponse.payload.descriptors)
    }, enumerateParams)

  const acquire = (acquireParams: {input: {path: string; previous: string | null}; signal?: AbortSignal}) =>
    scheduleTransportAction(
      async (signal: AbortSignal) => {
        const {path} = acquireParams.input
        const acquireIntentResponse = await sessions.acquireIntent(acquireParams.input)
        if (!acquireIntentResponse.success) {
          return error(acquireIntentResponse.error)
        }

        const reset = !!acquireParams.input.previous
        const openDeviceResult = await api.openDevice(acquireIntentResponse.payload.path, {
          reset,
          signal,
          channel: 'read',
        })
        if (!openDeviceResult.success) return openDeviceResult

        sessions.acquireDone({path, ...(id !== undefined ? {sessionOwner: id} : {})})
        return success(acquireIntentResponse.payload.session)
      },
      acquireParams,
      [ERRORS.DEVICE_DISCONNECTED_DURING_ACTION, ERRORS.SESSION_WRONG_PREVIOUS],
    )

  const subscribe = (subscribeParams: {path: string; channels: string[]; signal?: AbortSignal}) =>
    scheduleTransportAction(async (signal: AbortSignal) => {
      const entries = await Promise.all(
        subscribeParams.channels.map(async (channel) => {
          try {
            const res = await api.openDevice(subscribeParams.path, {
              reset: false,
              signal,
              channel: channel as 'read' | 'trezor-push-notification' | 'battery-level',
            })
            return [channel, res.success]
          } catch (e: unknown) {
            // `false` is also a channel that answered unsuccessfully, so a channel that threw
            // and one that refused are the same result.
            logger?.debug('Trezor channel probe threw; reporting it unavailable', {
              origin: 'trezor-native/adapter',
              channel,
              error: String(e),
            })
            return [channel, false]
          }
        }),
      )
      const map = Object.fromEntries(entries)
      return success(map)
    }, subscribeParams)

  const release = (releaseParams: {path: string; session: string; signal?: AbortSignal}) =>
    scheduleTransportAction(async () => {
      const releaseIntentResponse = await sessions.releaseIntent({
        session: releaseParams.session,
      })
      if (!releaseIntentResponse.success) {
        return error(releaseIntentResponse.error)
      }

      await api.closeDevice(releaseIntentResponse.payload.path, {channel: 'read'})
      await sessions.releaseDone({path: releaseIntentResponse.payload.path})
      return success(null)
    }, releaseParams)

  const releaseSync = (session: string) => {
    sessions.releaseIntent({session}).then((res) => {
      if (res.success) api.closeDevice(res.payload.path, {channel: 'read'})
    })
  }

  const call = (callParams: {
    session: string
    name: string
    data: Record<string, unknown>
    signal?: AbortSignal
    timeout?: number
    protocol?: TransportProtocol
    thpState?: thp.ThpState
  }) =>
    withThpSerialization(callParams.protocol, callParams.thpState, () =>
      scheduleTransportAction(
        async (signal: AbortSignal) => {
          const handleCallError = (callError: string) => {
            if (callError === ERRORS.DEVICE_DISCONNECTED_DURING_ACTION) {
              enumerate()
            }
          }

          const getPathResponse = await sessions.getPathBySession({session: callParams.session})
          if (!getPathResponse.success) {
            if (getPathResponse.error === 'session not found') {
              return error(ERRORS.DEVICE_DISCONNECTED_DURING_ACTION)
            }
            return error(ERRORS.UNEXPECTED_ERROR)
          }

          const {path} = getPathResponse.payload
          const protocol = callParams.protocol || 'v1'

          if (protocol === 'v2') {
            // THP (v2) protocol path
            const thpState = callParams.thpState
            if (!thpState) return error(ERRORS.UNEXPECTED_ERROR, 'ThpStateMissing')

            logger?.debug(
              `v2 encode ${callParams.name}: sessionId=${thpState.sessionId ? bytesToHex(thpState.sessionId as Uint8Array) : undefined}, sendNonce=${thpState.sendNonce}, sendBit=${thpState.sendBit}`,
            )
            const encoded = thp.encodeThp({
              messageName: callParams.name,
              data: callParams.data,
              thpState,
              protobufEncoder: (name, data) => encodeMessage(messages, name, data),
            })
            const [, chunkHeader] = thp.v2.getHeaders(encoded)
            const chunks = createChunks(encoded, chunkHeader, api.chunkSize)

            let progress = 0
            const apiWrite = (chunk: Uint8Array, attemptSignal?: AbortSignal) => {
              if (chunks.length > 1) {
                progress++
                emitter.emit(TRANSPORT.SEND_MESSAGE_PROGRESS, progress / chunks.length)
              }
              return api.write(path, chunk, attemptSignal || signal)
            }
            const apiRead = (attemptSignal?: AbortSignal) => api.read(path, attemptSignal || signal)

            const prevNonce = thpState.sendNonce
            const callResult = await thp.callThpMessage({
              thpState,
              chunks,
              apiWrite,
              apiRead,
              signal,
              logger,
            })
            if (!callResult.success) {
              handleCallError(callResult.error)
              return callResult
            }

            // Drift guard: only sync send if thpLoop hasn't already advanced the nonce
            if (prevNonce === thpState.sendNonce) {
              thp.syncState(thpState, 'send', callParams.name)
            }

            try {
              logger?.debug(`v2 parseThpMessage for ${callParams.name}, messageType=${callResult.payload.messageType}`)
              const message = thp.parseThpMessage({
                decoded: callResult.payload,
                protobufDecoder: (messageType, data) => {
                  logger?.debug(`v2 protobufDecoder messageType=${messageType}, dataLen=${data?.length}`)
                  return decodeMessage(messages, messageType, data)
                },
                thpState,
              })
              logger?.debug(
                `v2 parseThpMessage done: ${message.type}, sessionIdAfter=${thpState.sessionId ? bytesToHex(thpState.sessionId as Uint8Array) : undefined}, recvNonce=${thpState.recvNonce}`,
              )
              // Sync recv after parse — skip ThpError since errors are unencrypted
              // and the device doesn't advance nonces (old loop skipped SEND_ACK for errors)
              if (message.type !== 'ThpError') {
                thp.syncState(thpState, 'recv', message.type)
              }
              return success(message)
            } catch (parseError) {
              logger?.error(
                `v2 parseThpMessage failed for ${callParams.name}: ${parseError instanceof Error ? parseError.message : parseError}`,
              )
              throw parseError
            }
          }

          // v1 protocol path
          const bytes = buildMessage(messages, callParams.name, callParams.data)
          const [, chunkHeader] = v1.getHeaders()
          const chunks = createChunks(bytes, chunkHeader, api.chunkSize)

          let progress = 0
          const apiWrite = (chunk: Uint8Array, attemptSignal?: AbortSignal) => {
            if (chunks.length > 1) {
              progress++
              emitter.emit(TRANSPORT.SEND_MESSAGE_PROGRESS, progress / chunks.length)
            }
            return api.write(path, chunk, attemptSignal || signal)
          }
          const apiRead = (attemptSignal?: AbortSignal) => api.read(path, attemptSignal || signal)

          const sendResult = await sendChunks(chunks, apiWrite)
          if (!sendResult.success) {
            handleCallError(sendResult.error)
            return sendResult
          }
          const readResult = await receiveAndParse(messages, apiRead)
          if (!readResult.success) {
            handleCallError(readResult.error)
            return readResult
          }
          return readResult
        },
        {signal: callParams.signal, graceful: true, timeout: callParams.timeout},
      ),
    )

  const send = (sendParams: {
    data: Record<string, unknown>
    session: string
    name: string
    signal?: AbortSignal
    timeout?: number
    protocol?: TransportProtocol
    thpState?: thp.ThpState
  }) =>
    withThpSerialization(sendParams.protocol, sendParams.thpState, () =>
      scheduleTransportAction(
        async (signal: AbortSignal) => {
          const getPathResponse = await sessions.getPathBySession({session: sendParams.session})
          if (!getPathResponse.success) {
            return error(getPathResponse.error)
          }

          const {path} = getPathResponse.payload
          const protocol = sendParams.protocol || 'v1'

          if (protocol === 'v2') {
            const thpState = sendParams.thpState
            if (!thpState) return error(ERRORS.UNEXPECTED_ERROR, 'ThpStateMissing')

            const encoded = thp.encodeThp({
              messageName: sendParams.name,
              data: sendParams.data,
              thpState,
              protobufEncoder: (name, data) => encodeMessage(messages, name, data),
            })
            const [, chunkHeader] = thp.v2.getHeaders(encoded)
            const chunks = createChunks(encoded, chunkHeader, api.chunkSize)

            const apiWrite = (chunk: Uint8Array, attemptSignal?: AbortSignal) =>
              api.write(path, chunk, attemptSignal || signal)
            const apiRead = (attemptSignal?: AbortSignal) => api.read(path, attemptSignal ?? signal)

            const sendResult = await thp.sendThpMessage({
              thpState,
              skipAck: true,
              chunks,
              apiWrite,
              apiRead,
              signal,
              logger,
            })
            // Sync send state only on success — matches upstream call path guard
            if (sendResult.success) {
              thp.syncState(thpState, 'send', sendParams.name)
            }
            return sendResult
          }

          // v1 protocol path
          const bytes = buildMessage(messages, sendParams.name, sendParams.data)
          const [, chunkHeader] = v1.getHeaders()
          const chunks = createChunks(bytes, chunkHeader, api.chunkSize)

          let progress = 0
          const apiWrite = (chunk: Uint8Array) => {
            if (chunks.length > 1) {
              progress++
              emitter.emit(TRANSPORT.SEND_MESSAGE_PROGRESS, progress / chunks.length)
            }
            return api.write(path, chunk, signal)
          }

          const sendResult = await sendChunks(chunks, apiWrite)

          if (!sendResult.success) {
            if (sendResult.error === ERRORS.DEVICE_DISCONNECTED_DURING_ACTION) {
              enumerate()
            }
          }
          return sendResult
        },
        {signal: sendParams.signal, graceful: true, timeout: sendParams.timeout},
      ),
    )

  const receiveMsg = (receiveParams: {
    session: string
    signal?: AbortSignal
    timeout?: number
    protocol?: TransportProtocol
    thpState?: thp.ThpState
  }) =>
    withThpSerialization(receiveParams.protocol, receiveParams.thpState, () =>
      scheduleTransportAction(
        async (signal: AbortSignal) => {
          const getPathResponse = await sessions.getPathBySession({session: receiveParams.session})
          if (!getPathResponse.success) {
            return error(getPathResponse.error)
          }

          const {path} = getPathResponse.payload
          const protocol = receiveParams.protocol || 'v1'

          if (protocol === 'v2') {
            const thpState = receiveParams.thpState
            if (!thpState) return error(ERRORS.UNEXPECTED_ERROR, 'ThpStateMissing')

            const apiWrite = (chunk: Uint8Array, attemptSignal?: AbortSignal) =>
              api.write(path, chunk, attemptSignal || signal)
            const apiRead = (attemptSignal?: AbortSignal) => api.read(path, attemptSignal || signal)

            const decoded = await thp.receiveThpMessage({
              thpState,
              skipAck: true,
              apiWrite,
              apiRead,
              signal,
              logger,
            })
            if (!decoded.success) return decoded

            const message = thp.parseThpMessage({
              decoded: decoded.payload,
              protobufDecoder: (messageType, data) => decodeMessage(messages, messageType, data),
              thpState,
            })
            // No recv sync here — upstream leaves it to the caller
            return success(message)
          }

          // v1 protocol path
          const apiRead = (attemptSignal?: AbortSignal) => api.read(path, attemptSignal || signal)

          const message = await receiveAndParse(messages, apiRead)
          if (!message.success) {
            if (message.error === ERRORS.DEVICE_DISCONNECTED_DURING_ACTION) {
              enumerate()
            }
          }
          return message
        },
        {signal: receiveParams.signal, graceful: true, timeout: receiveParams.timeout},
      ),
    )

  const releaseDevice = async (session: string) => {
    const response = sessions.getPathBySession({session})
    if (response.success) {
      return api.closeDevice(response.payload.path, {channel: 'read'})
    }
    return success(undefined)
  }

  const stop = () => {
    if (!stopped) {
      api.once('transport-interface-change', () => {
        logger?.debug('device connected after transport stopped, goodbye...')
      })
    }
    emitter.emit(TRANSPORT.STOPPED)
    emitter.removeAllListeners()
    deviceEventsEmitter.removeAllListeners()
    stopped = true
    listening = false
    abortController.abort()
    descriptors = []
    api.dispose()
  }

  const ping = async () => false

  const getMessage = (message = 'GetFeatures') => !!messages.get(message)

  const getMessages = () => messages

  const updateMessages = (msgs: ProtobufMessages) => {
    messages = parseConfigure(msgs)
  }

  const loadMsgs = (packageName: string, packageLoader: () => ProtobufMessages | Promise<ProtobufMessages>) =>
    loadDefinitions(messages, packageName, packageLoader)

  const getDescriptor = (path: string) => descriptors.find((d) => d.path === path)

  return {
    // Identity
    name,
    isOutdated: false,
    version: '',
    apiType: api.type,

    // Device events emitter (per-device)
    deviceEvents: deviceEventsEmitter,

    // EventEmitter interface (transport-level)
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    once: emitter.once.bind(emitter),
    emit: emitter.emit.bind(emitter),

    // Required methods (duck-typed by isTransportInstance)
    init,
    enumerate,
    listen,
    acquire,
    release,
    send,
    receive: receiveMsg,
    call,

    // Additional transport methods
    stop,
    ping,
    subscribe,
    releaseSync,
    releaseDevice,
    handleDescriptorsChange: (nextDescriptors: Descriptor[]) => {
      if (!stopped) {
        descriptors = handleDescriptorsChange(descriptors, nextDescriptors, emitter, deviceEventsEmitter)
      }
    },
    getMessage,
    getMessages,
    updateMessages,
    loadMessages: loadMsgs,
    getDescriptor,
  }
}
