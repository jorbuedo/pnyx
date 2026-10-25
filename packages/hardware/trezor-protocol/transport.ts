/**
 * Message building, chunking, sending, and receiving.
 *
 * Replaces @trezor/transport/lib/utils/send.ts and receive.ts.
 *
 * @module
 */

import {bytesEqual, bytesToHex, concatBytes} from './bytes'
import {PROTOCOL_MALFORMED} from './errors'
import type {MessageResponse} from './protobuf'
import {decodeMessage, encodeMessage} from './protobuf'
import * as v1 from './v1'

// --- Result types (local to avoid circular deps) ---

type Success<T> = {readonly success: true; readonly payload: T}
type ErrorResult = {readonly success: false; readonly error: string; readonly message?: string | undefined}
type Result<T> = Success<T> | ErrorResult

const ok = <T>(payload: T): Success<T> => ({success: true, payload})
const fail = (err: string, message?: string): ErrorResult => ({success: false, error: err, message})

// --- Chunking ---

/**
 * Split an encoded message into HID-report-sized chunks.
 *
 * First chunk: raw data up to chunkSize (includes the 9-byte protocol header).
 * Subsequent chunks: chunkHeader prefix + data, padded to chunkSize.
 *
 * @param data - Complete encoded message (header + payload)
 * @param chunkHeader - 1-byte chunk prefix (0x3F for v1)
 * @param chunkSize - HID report size (typically 64)
 */
export const createChunks = (data: Uint8Array, chunkHeader: Uint8Array, chunkSize: number): Uint8Array[] => {
  if (!chunkSize || data.byteLength <= chunkSize) {
    const buffer = new Uint8Array(Math.max(chunkSize, data.byteLength))
    buffer.set(data)
    return [buffer]
  }

  // First chunk: data padded to chunkSize (consistent with subsequent chunks)
  const firstChunk = new Uint8Array(chunkSize)
  firstChunk.set(data.subarray(0, chunkSize))
  const chunks: Uint8Array[] = [firstChunk]

  // Subsequent chunks: chunkHeader + data, padded to chunkSize
  let position = chunkSize
  while (position < data.byteLength) {
    const sliceEnd = Math.min(position + chunkSize - chunkHeader.byteLength, data.byteLength)
    const slice = data.subarray(position, sliceEnd)
    const chunk = concatBytes(chunkHeader, slice)
    const padded = new Uint8Array(chunkSize)
    padded.set(chunk)
    chunks.push(padded)
    position = sliceEnd
  }

  return chunks
}

// --- Build message ---

/**
 * Encode a named protobuf message and frame it with the v1 protocol.
 *
 * @param messages - Configured protobuf Root
 * @param name - Message type name (e.g. 'GetFeatures')
 * @param data - Message payload object
 * @returns Complete encoded frame (header + payload), ready for chunking
 */
export const buildMessage = (
  messages: import('protobufjs').Root,
  name: string,
  data: Record<string, unknown>,
): Uint8Array => {
  const {messageType, message} = encodeMessage(messages, name, data)
  return v1.encode(message, messageType)
}

// --- Send ---

type ApiWrite = (chunk: Uint8Array, signal?: AbortSignal) => Promise<Result<unknown>>

/**
 * Send all chunks sequentially via the device write API.
 */
export const sendChunks = async (chunks: Uint8Array[], apiWrite: ApiWrite): Promise<Result<undefined>> => {
  for (const chunk of chunks) {
    const result = await apiWrite(chunk)
    if (!result.success) return result as ErrorResult
  }
  return ok(undefined)
}

// --- Receive ---

type ApiRead = (signal?: AbortSignal) => Promise<Result<Uint8Array>>

/**
 * Receive and reassemble a complete v1 protocol message from chunked HID reports.
 *
 * Reads the first chunk, decodes the header to get total length,
 * then reads subsequent chunks until the full payload is assembled.
 */
export const receive = async (
  receiver: ApiRead,
): Promise<Result<{messageType: number; payload: Uint8Array; header: Uint8Array; length: number}>> => {
  const readResult = await receiver()
  if (!readResult.success) return readResult

  try {
    const {length, messageType, payload, header} = v1.decode(readResult.payload)
    const [, chunkHeader] = v1.getHeaders()

    const result = new Uint8Array(length)
    result.set(payload.subarray(0, Math.min(payload.length, length)))

    let offset = payload.length
    while (offset < length) {
      const chunkResult = await receiver()
      if (!chunkResult.success) return chunkResult

      const data = chunkResult.payload
      const dataChunkHeader = data.subarray(0, chunkHeader.length)
      if (!bytesEqual(dataChunkHeader, chunkHeader)) {
        throw new Error(`Unexpected chunkHeader ${bytesToHex(dataChunkHeader)}`)
      }

      const chunkPayload = data.subarray(chunkHeader.byteLength)
      result.set(chunkPayload.subarray(0, Math.min(chunkPayload.length, length - offset)), offset)
      offset += data.byteLength - chunkHeader.byteLength
    }

    return ok({messageType, payload: result, header, length})
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return fail(PROTOCOL_MALFORMED, msg)
  }
}

/**
 * Receive, reassemble, and decode a protobuf message.
 */
export const receiveAndParse = async (
  messages: import('protobufjs').Root,
  receiver: ApiRead,
): Promise<Result<MessageResponse>> => {
  const readResult = await receive(receiver)
  if (!readResult.success) return readResult

  const {messageType, payload} = readResult.payload
  const message = decodeMessage(messages, messageType, payload)

  return ok(message)
}
