/**
 * The multi-part payload: `[seqNum, seqLen, messageLen, checksum, data]`.
 *
 * Field order is wire format. CBOR comes from `@evolution-sdk/evolution` — a general RFC 8949 codec
 * that happens to live there; see this package's README for why there is deliberately not a
 * second one.
 *
 * @module
 */

import * as Cbor from '@evolution-sdk/evolution/CBORBuilder'

export type FountainPart = {
  /** 1-based. Above `seqLen` the part carries a mix rather than a single fragment. */
  readonly seqNum: number
  readonly seqLen: number
  /** Length of the *original* message, before fragments were zero-padded. */
  readonly messageLen: number
  /** CRC-32 of the original message; also seeds fragment selection. */
  readonly checksum: number
  readonly data: Uint8Array
}

export const encodePart = (part: FountainPart): Uint8Array =>
  Cbor.Serializer.newVec()
    .writeArray(Cbor.len(5))
    .writeUnsignedInteger(part.seqNum)
    .writeUnsignedInteger(part.seqLen)
    .writeUnsignedInteger(part.messageLen)
    .writeUnsignedInteger(part.checksum)
    .writeBytes(part.data)
    .finalize()

export type PartResult = {readonly ok: true; readonly part: FountainPart} | {readonly ok: false; readonly error: string}

/**
 * Every field is bounds-checked before it is used.
 *
 * This parses a scanned code, so the numbers are attacker-chosen: `seqLen` sizes the decoder's
 * fragment table and `messageLen` sizes the output buffer, and neither may be taken on trust. The
 * ceilings are far above any real QR sequence and exist only to keep a hostile part from
 * allocating.
 */
const MAX_SEQ_LEN = 1_000_000
const MAX_MESSAGE_LEN = 64 * 1024 * 1024

export const decodePart = (cbor: Uint8Array): PartResult => {
  try {
    const reader = Cbor.Deserializer.from(cbor)
    const length = reader.array()
    // `typeof` rather than `=== Cbor.INDEFINITE`: the constant is declared as the union type, so
    // comparing against it does not narrow and `.definite` stays an error.
    if (typeof length === 'string' || length.definite !== 5) {
      return {ok: false, error: `expected a definite 5-element array, got ${JSON.stringify(length)}`}
    }
    const seqNum = Number(reader.unsignedInteger())
    const seqLen = Number(reader.unsignedInteger())
    const messageLen = Number(reader.unsignedInteger())
    const checksum = Number(reader.unsignedInteger())
    const data = reader.bytes()

    if (seqNum < 1) return {ok: false, error: `seqNum ${seqNum} must be at least 1`}
    if (seqLen < 1 || seqLen > MAX_SEQ_LEN) return {ok: false, error: `seqLen ${seqLen} is out of range`}
    if (messageLen < 1 || messageLen > MAX_MESSAGE_LEN) {
      return {ok: false, error: `messageLen ${messageLen} is out of range`}
    }
    if (data.length === 0) return {ok: false, error: 'a part carries no data'}
    // Fragments are equal-length and cover the message, so this is the only consistent shape.
    if (seqLen * data.length < messageLen) {
      return {ok: false, error: `${seqLen} fragments of ${data.length} cannot hold ${messageLen} bytes`}
    }
    return {ok: true, part: {seqNum, seqLen, messageLen, checksum, data}}
  } catch (error) {
    return {ok: false, error: error instanceof Error ? error.message : String(error)}
  }
}
