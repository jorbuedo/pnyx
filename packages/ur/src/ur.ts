/**
 * The UR string format (BCR-2020-005).
 *
 * ```
 * single-part   ur:<type>/<bytewords>
 * multi-part    ur:<type>/<seqNum>-<seqLen>/<bytewords>
 * ```
 *
 * A UR carries CBOR; this module is only the envelope, so the payload stays opaque bytes here
 * and gains meaning in the registry layer.
 *
 * @module
 */

import {decodeBytewords, encodeBytewords} from './bytewords.js'

/** A decoded UR: its registry type and the CBOR it carries. */
export type Ur = {
  /** Registry type, lowercase — `bytes`, `crypto-hdkey`, `cardano-sign-request`, … */
  readonly type: string
  /** The CBOR payload, undecoded. */
  readonly cbor: Uint8Array
}

/** A multi-part UR: a {@link Ur} plus its position in the sequence. */
export type MultiPartUr = Ur & {
  /** 1-based. Beyond `seqLen` the part is a fountain mix rather than a single fragment. */
  readonly seqNum: number
  readonly seqLen: number
}

export type UrError =
  | {readonly kind: 'not-a-ur'; readonly detail: string}
  | {readonly kind: 'invalid-type'; readonly type: string}
  | {readonly kind: 'invalid-sequence'; readonly detail: string}
  | {readonly kind: 'invalid-payload'; readonly detail: string}

export type UrResult<T> = {readonly ok: true; readonly value: T} | {readonly ok: false; readonly error: UrError}

/**
 * Registry types are lowercase alphanumerics and hyphens. Enforced on the way in as well as out:
 * the type selects how the payload is interpreted, so accepting a loose one would let a scanned
 * code steer parsing.
 */
const TYPE_PATTERN = /^[a-z0-9][a-z0-9-]*$/

const SCHEME = 'ur:'

export const isValidUrType = (type: string): boolean => TYPE_PATTERN.test(type)

/**
 * Whether a scanned string is a UR frame at all.
 *
 * Deliberately only the scheme: a general QR scanner needs to route a frame to an accumulating
 * session *before* it can know whether the payload is well-formed, and a mis-read frame of a
 * genuine sequence must still be treated as part of that sequence rather than fall through to
 * address parsing. Well-formedness is `decodeUr`'s answer, not this one's.
 */
export const isUrFrame = (input: string): boolean => input.trim().toLowerCase().startsWith(SCHEME)

/** `ur:<type>/<bytewords>`. */
export const encodeSinglePartUr = (ur: Ur): string => {
  if (!isValidUrType(ur.type)) throw new Error(`ur: invalid type ${JSON.stringify(ur.type)}`)
  return `${SCHEME}${ur.type}/${encodeBytewords(ur.cbor, 'minimal')}`
}

/** `ur:<type>/<seqNum>-<seqLen>/<bytewords>`. */
export const encodeMultiPartUr = (part: MultiPartUr): string => {
  if (!isValidUrType(part.type)) throw new Error(`ur: invalid type ${JSON.stringify(part.type)}`)
  if (part.seqNum < 1 || !Number.isInteger(part.seqNum)) throw new Error(`ur: bad seqNum ${part.seqNum}`)
  if (part.seqLen < 1 || !Number.isInteger(part.seqLen)) throw new Error(`ur: bad seqLen ${part.seqLen}`)
  return `${SCHEME}${part.type}/${part.seqNum}-${part.seqLen}/${encodeBytewords(part.cbor, 'minimal')}`
}

const decodePayload = (bytewords: string): UrResult<Uint8Array> => {
  const decoded = decodeBytewords(bytewords, 'minimal')
  if (!decoded.ok) {
    return {ok: false, error: {kind: 'invalid-payload', detail: `${decoded.error.kind}`}}
  }
  return {ok: true, value: decoded.data}
}

const SEQUENCE_PATTERN = /^(\d+)-(\d+)$/

/**
 * Parse either form.
 *
 * **Input is lowercased first.** QR alphanumeric mode has no lowercase, so real devices emit
 * `UR:BYTES/…` to keep the code small — a decoder that only accepted the canonical spelling would
 * fail against most of them.
 */
export const decodeUr = (input: string): UrResult<Ur | MultiPartUr> => {
  const normalized = input.trim().toLowerCase()
  if (!normalized.startsWith(SCHEME)) {
    return {ok: false, error: {kind: 'not-a-ur', detail: 'missing the "ur:" scheme'}}
  }

  const body = normalized.slice(SCHEME.length)
  const segments = body.split('/')
  if (segments.length !== 2 && segments.length !== 3) {
    return {ok: false, error: {kind: 'not-a-ur', detail: `expected 2 or 3 path segments, got ${segments.length}`}}
  }

  const [type, ...rest] = segments
  if (type === undefined || !isValidUrType(type)) {
    return {ok: false, error: {kind: 'invalid-type', type: type ?? ''}}
  }

  if (rest.length === 1) {
    const payload = decodePayload(rest[0] ?? '')
    return payload.ok ? {ok: true, value: {type, cbor: payload.value}} : payload
  }

  const [sequence, bytewords] = rest
  const match = SEQUENCE_PATTERN.exec(sequence ?? '')
  if (match === null) {
    return {ok: false, error: {kind: 'invalid-sequence', detail: `expected <seqNum>-<seqLen>, got ${sequence}`}}
  }
  const seqNum = Number(match[1])
  const seqLen = Number(match[2])
  if (seqNum < 1 || seqLen < 1) {
    return {ok: false, error: {kind: 'invalid-sequence', detail: `seqNum and seqLen are 1-based, got ${sequence}`}}
  }
  // A part beyond seqLen is a legitimate fountain mix, so only the degenerate direction is an
  // error; but seqLen itself must be sane or the decoder would allocate against a hostile number.
  if (!Number.isSafeInteger(seqNum) || !Number.isSafeInteger(seqLen)) {
    return {ok: false, error: {kind: 'invalid-sequence', detail: `sequence numbers are out of range: ${sequence}`}}
  }

  const payload = decodePayload(bytewords ?? '')
  return payload.ok ? {ok: true, value: {type, cbor: payload.value, seqNum, seqLen}} : payload
}

/** Narrow a decoded UR to the multi-part form. */
export const isMultiPart = (ur: Ur | MultiPartUr): ur is MultiPartUr => 'seqNum' in ur
