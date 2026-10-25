/**
 * THP send/ack/receive state machine.
 *
 * Drives the full round-trip for a THP message, handling ACK polling,
 * retransmission, and error recovery.
 *
 * @module
 */

import {getLogger} from '@pnyx/logger'
import {bytesEqual, bytesToHex} from '../bytes'
import {PROTOCOL_MALFORMED} from '../errors'
import {sendChunks} from '../transport'
import {scheduleAction} from '../utils'
import {THP_CONTROL_BYTE} from './constants'
import {decode as decodeThpFrame, getCRC, validateCrc} from './decode'
import {encodeAck} from './encode'
import type {ThpState} from './state'
import type {DecodedThpMessage, ThpMessageResponse} from './types'
import {getExpectedResponses, isAckExpected, readThpHeader} from './utils'
import * as v2 from './v2'

const logger = getLogger('hardware')

// --- Constants ---

const ATTEMPTS_LIMIT = 10
const THP_ACK_TIMEOUT = 10_000
const THP_ACK_DEADLINE = 30_000
const RECENT_ACK_LIMIT = 10
const THP_STATE_ERROR = 'THP_STATE_ERROR'

// --- Result types ---

type Success<T> = {readonly success: true; readonly payload: T}
type ErrorResult = {readonly success: false; readonly error: string; readonly message?: string | undefined}
type Result<T> = Success<T> | ErrorResult

const ok = <T>(payload: T): Success<T> => ({success: true, payload})
const fail = (err: string, message?: string): ErrorResult => ({success: false, error: err, message})

// --- API types ---

type ApiWrite = (chunk: Uint8Array, signal?: AbortSignal) => Promise<Result<unknown>>
type ApiRead = (signal?: AbortSignal) => Promise<Result<Uint8Array>>

export type ThpLoopCommonProps = {
  apiWrite: ApiWrite
  apiRead: ApiRead
  thpState: ThpState
  skipAck?: boolean | undefined
  signal?: AbortSignal | undefined
  logger?: {debug: (...args: unknown[]) => void} | undefined
  chunks: Uint8Array[]
}

// --- v2 receive (reassemble chunked response) ---

const receiveV2 = async (receiver: ApiRead): Promise<Result<DecodedThpMessage>> => {
  const readResult = await receiver()
  if (!readResult.success) return readResult as ErrorResult

  try {
    // Type assertion: when @types/node is in scope (e.g. via bun-types),
    // v2 module parameter types may resolve as Buffer instead of Uint8Array.
    const bytes = readResult.payload as Parameters<typeof v2.decode>[0]
    const decoded = v2.decode(bytes)
    const [, chunkHeader] = v2.getHeaders(bytes)

    const result = new Uint8Array(decoded.length)
    result.set(decoded.payload.subarray(0, Math.min(decoded.payload.length, decoded.length)))

    let offset = decoded.payload.length
    while (offset < decoded.length) {
      const chunkResult = await receiver()
      if (!chunkResult.success) return chunkResult as ErrorResult

      const data = new Uint8Array(chunkResult.payload)
      const dataChunkHeader = data.subarray(0, chunkHeader.length)
      if (!dataChunkHeader.every((byte, i) => byte === chunkHeader[i])) {
        throw new Error(`Unexpected chunkHeader ${bytesToHex(dataChunkHeader)}`)
      }

      const chunkPayload = data.subarray(chunkHeader.byteLength)
      result.set(chunkPayload.subarray(0, Math.min(chunkPayload.length, decoded.length - offset)), offset)
      offset += data.byteLength - chunkHeader.byteLength
    }

    return ok({
      ...decoded,
      payload: result,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return fail(PROTOCOL_MALFORMED, msg)
  }
}

// --- receiveExpectedMessage ---

type ReceiveExpectedError =
  | 'UnexpectedChunk'
  | 'UnexpectedChannel'
  | 'UnexpectedCRC'
  | 'UnexpectedRecvBit'
  | 'UnexpectedRecentMessage'
  | 'UnexpectedMessage'
  | 'Timeout'

const isRecentMessage = (msg: DecodedThpMessage, thpState: ThpState): boolean => {
  if (thpState.recentMessage.length > 0) {
    return bytesEqual(thpState.recentMessage, getCRC(msg))
  }
  return false
}

const receiveExpectedMessage = async (
  apiRead: ApiRead,
  thpState: ThpState,
  signal?: AbortSignal,
  timeout?: number,
  debug?: (msg: string) => void,
): Promise<Result<DecodedThpMessage> | ErrorResult> => {
  let receiveResult: Result<DecodedThpMessage>
  try {
    receiveResult = await scheduleAction(
      (attemptSignal) => receiveV2(() => apiRead(attemptSignal)),
      signal || timeout !== undefined ? {signal, timeout} : undefined,
    )
  } catch (e: unknown) {
    // Reported as a timeout whatever happened, so a transport that threw for another reason is
    // indistinguishable from a device that did not answer.
    logger.debug('THP receive failed; reporting a timeout', {origin: 'trezor/thp-loop', error: String(e)})
    return fail('Timeout')
  }

  if (!receiveResult.success) {
    debug?.(`recv failed: ${receiveResult.error} ${(receiveResult as ErrorResult).message ?? ''}`)
    if (receiveResult.error === PROTOCOL_MALFORMED) {
      return fail('UnexpectedChunk')
    }
    if (receiveResult.error === 'Timeout') {
      return fail('Timeout')
    }
    return receiveResult
  }

  const encodedMessage = receiveResult.payload
  const thpHeader = readThpHeader(encodedMessage.header)
  debug?.(
    `recv ok: ctrl=0x${encodedMessage.messageType.toString(16)} ch=${bytesToHex(thpHeader.channel)} len=${encodedMessage.length} header=${bytesToHex(encodedMessage.header)}`,
  )

  const isExpectedChannel = bytesEqual(thpHeader.channel, thpState.channel)
  if (!isExpectedChannel) {
    return fail('UnexpectedChannel')
  }

  try {
    validateCrc(encodedMessage)
  } catch (e: unknown) {
    logger.debug('THP message failed CRC validation', {origin: 'trezor/thp-loop', error: String(e)})
    return fail('UnexpectedCRC')
  }

  if (encodedMessage.messageType === THP_CONTROL_BYTE.ERROR) {
    return receiveResult as Success<DecodedThpMessage>
  }

  if (encodedMessage.messageType === THP_CONTROL_BYTE.ACK_MESSAGE) {
    return receiveResult as Success<DecodedThpMessage>
  }

  const isExpectedCtrlByte = thpState.expectedResponses.find((m) => m === encodedMessage.messageType)
  if (!isExpectedCtrlByte) {
    const recent = isRecentMessage(encodedMessage, thpState)
    debug?.(
      `recv ctrl=0x${encodedMessage.messageType.toString(16)} expected=[${thpState.expectedResponses.map((r) => `0x${r.toString(16)}`)}] seqBit=${thpHeader.sequenceBit} recvBit=${thpState.recvBit} recent=${recent}`,
    )
    if (recent) {
      return fail('UnexpectedRecentMessage')
    }
    return fail('UnexpectedMessage')
  }

  if (thpHeader.sequenceBit !== thpState.recvBit) {
    const recent = isRecentMessage(encodedMessage, thpState)
    debug?.(
      `recv ctrl=0x${encodedMessage.messageType.toString(16)} seqBit=${thpHeader.sequenceBit} expected recvBit=${thpState.recvBit} recent=${recent}`,
    )
    if (recent) {
      return fail('UnexpectedRecentMessage')
    }
    return fail('UnexpectedRecvBit')
  }

  return receiveResult as Success<DecodedThpMessage>
}

// --- ThpLoop state machine ---

enum ThpLoopState {
  WRITE_REQUEST,
  READ_ACK,
  READ_RESPONSE,
  SEND_ACK,
  SEND_RECENT_ACK,
  DONE,
}

type ThpLoopProps = ThpLoopCommonProps & {
  sendOnly?: boolean
  receiveOnly?: boolean
}

export const thpLoop = async ({
  chunks,
  thpState,
  apiWrite,
  apiRead,
  signal,
  logger,
  skipAck,
  sendOnly,
  receiveOnly,
}: ThpLoopProps): Promise<Result<DecodedThpMessage> | undefined> => {
  const caller = (sendOnly && 'sendThpMessage') || (receiveOnly && 'receiveThpMessage') || 'callThpMessage'
  const debug = logger ? (msg: string) => logger.debug(`${caller} ${msg}`) : () => {}

  let phase = receiveOnly ? ThpLoopState.READ_RESPONSE : ThpLoopState.WRITE_REQUEST
  let writeAttempt = 0
  let readAttempt = 0
  const deadline = Date.now() + THP_ACK_DEADLINE
  const isDeadlineReached = () => Date.now() >= deadline
  const thpStateError = (message: string) => fail(THP_STATE_ERROR, message)
  let result: Result<DecodedThpMessage> | undefined
  let recentAckCount = 0

  while (phase !== ThpLoopState.DONE) {
    switch (phase) {
      case ThpLoopState.WRITE_REQUEST: {
        debug(`WRITE_REQUEST attempt ${writeAttempt}`)

        if (++writeAttempt > ATTEMPTS_LIMIT) {
          return thpStateError('RetriesExceeded')
        }

        if (isDeadlineReached()) {
          return thpStateError('Aborted by deadline')
        }

        const sendResult = await sendChunks(chunks, apiWrite)
        debug(`WRITE_REQUEST success: ${sendResult.success}`)
        if (!sendResult.success) return sendResult

        if (!sendOnly) {
          const firstChunk = chunks[0]
          if (firstChunk) {
            const expectedResponses = getExpectedResponses(firstChunk)
            thpState.expectedResponses = expectedResponses
          }
        }

        const firstChunk = chunks[0]
        const ackExpected = firstChunk ? !skipAck && isAckExpected(firstChunk) : false
        if (ackExpected) {
          phase = ThpLoopState.READ_ACK
        } else if (sendOnly) {
          phase = ThpLoopState.DONE
        } else {
          phase = ThpLoopState.READ_RESPONSE
        }
        break
      }

      case ThpLoopState.READ_ACK: {
        debug('READ_ACK')

        if (isDeadlineReached()) {
          phase = ThpLoopState.WRITE_REQUEST
          break
        }

        const ackResult = await receiveExpectedMessage(apiRead, thpState, signal, THP_ACK_TIMEOUT, debug)
        if (!ackResult.success) {
          switch (ackResult.error as ReceiveExpectedError) {
            case 'UnexpectedChunk':
              break // keep reading
            case 'UnexpectedCRC':
              return thpStateError(ackResult.error)
            case 'UnexpectedChannel':
              break // keep reading
            case 'UnexpectedRecentMessage':
              phase = ThpLoopState.SEND_RECENT_ACK
              break
            case 'Timeout':
            case 'UnexpectedMessage':
            case 'UnexpectedRecvBit':
              phase = ThpLoopState.WRITE_REQUEST
              break
            default:
              return ackResult
          }
          break
        }

        if (sendOnly) {
          phase = ThpLoopState.DONE
          break
        }

        switch (ackResult.payload.messageType) {
          case THP_CONTROL_BYTE.ACK_MESSAGE: {
            const {ackBit} = readThpHeader(ackResult.payload.header)
            if (ackBit === thpState.sendAckBit) {
              recentAckCount = 0
              phase = ThpLoopState.READ_RESPONSE
            } else {
              debug(`READ_ACK unexpected ackBit=${ackBit} expected=${thpState.sendAckBit}`)
            }
            break
          }
          case THP_CONTROL_BYTE.ERROR:
            result = ackResult as Success<DecodedThpMessage>
            phase = ThpLoopState.DONE
            break
          default:
            debug('READ_ACK received response')
            result = ackResult as Success<DecodedThpMessage>
            phase = ThpLoopState.SEND_ACK
            break
        }
        break
      }

      case ThpLoopState.READ_RESPONSE: {
        debug('READ_RESPONSE')

        if (++readAttempt > ATTEMPTS_LIMIT) {
          return thpStateError('RetriesExceeded')
        }

        // No per-read timeout — READ_RESPONSE may wait for user interaction
        // (signing, PIN, passphrase, pairing) which can take minutes.
        // The outer signal handles abort.
        const receiveResult = await receiveExpectedMessage(apiRead, thpState, signal, undefined, debug)
        if (!receiveResult.success) {
          debug(`READ_RESPONSE error=${receiveResult.error} message=${(receiveResult as ErrorResult).message ?? ''}`)
          switch (receiveResult.error as ReceiveExpectedError) {
            case 'UnexpectedChunk':
              break // keep reading
            case 'UnexpectedCRC':
              return thpStateError(receiveResult.error)
            case 'UnexpectedChannel':
              break // keep reading
            case 'UnexpectedRecentMessage':
              if (receiveOnly) {
                phase = ThpLoopState.SEND_RECENT_ACK
                break
              } else {
                return thpStateError(receiveResult.error)
              }
            case 'Timeout':
            case 'UnexpectedMessage':
            case 'UnexpectedRecvBit':
              return thpStateError(receiveResult.error)
            default:
              return receiveResult
          }
          break
        }

        switch (receiveResult.payload.messageType) {
          case THP_CONTROL_BYTE.ACK_MESSAGE:
            break // keep reading
          case THP_CONTROL_BYTE.ERROR:
            result = receiveResult as Success<DecodedThpMessage>
            phase = ThpLoopState.DONE
            break
          default:
            result = receiveResult as Success<DecodedThpMessage>
            phase = ThpLoopState.SEND_ACK
            break
        }
        break
      }

      case ThpLoopState.SEND_RECENT_ACK: {
        recentAckCount++
        debug(`SEND_RECENT_ACK #${recentAckCount}`)

        // Send ACK with the previous recvAckBit (downgraded by one toggle)
        const prevAckBit = thpState.recvAckBit > 0 ? 0 : 1
        const prevState = {
          ...thpState,
          recvAckBit: prevAckBit as 0 | 1,
        }
        const chunk = encodeAck(prevState)
        const ackResult = await apiWrite(chunk, signal)
        if (!ackResult.success) return ackResult as ErrorResult

        if (receiveOnly) {
          phase = ThpLoopState.READ_RESPONSE
        } else if (recentAckCount >= RECENT_ACK_LIMIT) {
          // After too many consecutive recent ACKs, the device likely never
          // received our message. Fall through to WRITE_REQUEST to retransmit.
          debug(`SEND_RECENT_ACK limit reached (${RECENT_ACK_LIMIT}), falling back to WRITE_REQUEST`)
          recentAckCount = 0
          phase = ThpLoopState.WRITE_REQUEST
        } else {
          // Drain stale retransmissions by reading again instead of resending.
          // Over BLE, the device retransmits continuously while idle, filling
          // the read buffer. Resending (WRITE_REQUEST) for each stale message
          // burns through the retry limit without progress. Going back to
          // READ_ACK drains the buffer quickly; if the device truly lost our
          // packet, we'll hit RECENT_ACK_LIMIT and retransmit.
          phase = ThpLoopState.READ_ACK
        }
        break
      }

      case ThpLoopState.SEND_ACK: {
        const ackExpected = isAckExpected(thpState.expectedResponses || [])
        debug(`SEND_ACK ${ackExpected}`)

        if (!skipAck && ackExpected) {
          const ack = await apiWrite(encodeAck(thpState), signal)
          if (!ack.success) return ack as ErrorResult
        }

        if (result?.success) {
          thpState.recentMessage = getCRC(result.payload)
        }

        phase = ThpLoopState.DONE
        break
      }
    }
  }

  return result
}

// --- High-level THP transport functions ---

export const callThpMessage = async (props: ThpLoopCommonProps): Promise<Result<DecodedThpMessage>> => {
  const result = await thpLoop(props)
  return result ?? fail(THP_STATE_ERROR, 'MissingResponse')
}

export const sendThpMessage = async (props: ThpLoopCommonProps): Promise<Result<undefined>> => {
  const result = await thpLoop({...props, sendOnly: true})
  return result && !result.success ? result : ok(undefined)
}

export const receiveThpMessage = async (
  props: Omit<ThpLoopCommonProps, 'chunks'>,
): Promise<Result<DecodedThpMessage>> => {
  const result = await thpLoop({...props, chunks: [], receiveOnly: true})
  return result ?? fail(THP_STATE_ERROR, 'MissingResponse')
}

// --- Parse received THP message via protobuf ---

export const parseThpMessage = ({
  decoded,
  protobufDecoder,
  thpState,
}: {
  decoded: DecodedThpMessage
  protobufDecoder: (messageType: string | number, data: Uint8Array) => ThpMessageResponse
  thpState: ThpState
}): ThpMessageResponse => {
  return decodeThpFrame(decoded, protobufDecoder, thpState)
}
