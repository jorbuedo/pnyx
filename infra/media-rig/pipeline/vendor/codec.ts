/**
 * Byte/text codecs: base64, hex, utf8.
 *
 * Thin, total-by-construction wrappers over @scure/base. Encoding is pure and
 * infallible; decoding returns `Either` so malformed input is a typed failure,
 * not a thrown exception.
 *
 * base64 decoding is deliberately liberal: it accepts standard and url-safe
 * alphabets, with or without padding (data serialized by the previous codec
 * implementation was unpadded).
 *
 * @module
 */

import {base64 as scureBase64, hex as scureHex} from '@scure/base'
import {Either} from 'effect'
import {CodecError} from './errors.js'

const tryDecode = (kind: string, text: string, decode: (text: string) => Uint8Array) =>
  Either.try({
    try: () => decode(text),
    catch: (e) =>
      new CodecError({
        message: `Invalid ${kind} input: ${e instanceof Error ? e.message : String(e)}`,
        cause: e,
      }),
  })

export const base64 = {
  /** Encode bytes as standard, padded base64. */
  encode: (data: Uint8Array): string => scureBase64.encode(data),
  /** Decode base64 text (standard or url-safe alphabet, padded or not). */
  decode: (text: string): Either.Either<Uint8Array, CodecError> => {
    const standard = text.replaceAll('-', '+').replaceAll('_', '/')
    const padded = standard.length % 4 === 0 ? standard : standard + '='.repeat(4 - (standard.length % 4))
    return tryDecode('base64', padded, scureBase64.decode)
  },
} as const

export const hex = {
  /** Encode bytes as lowercase hex. */
  encode: (data: Uint8Array): string => scureHex.encode(data),
  /** Decode hex text (either case). */
  decode: (text: string): Either.Either<Uint8Array, CodecError> =>
    tryDecode('hex', text.toLowerCase(), scureHex.decode),
} as const

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder(undefined, {fatal: true})

export const utf8 = {
  /** Encode a string as UTF-8 bytes. */
  encode: (text: string): Uint8Array => textEncoder.encode(text),
  /** Decode UTF-8 bytes to a string; invalid sequences are a typed failure. */
  decode: (data: Uint8Array): Either.Either<string, CodecError> =>
    Either.try({
      try: () => textDecoder.decode(data),
      catch: (e) =>
        new CodecError({
          message: `Invalid utf8 input: ${e instanceof Error ? e.message : String(e)}`,
          cause: e,
        }),
    }),
} as const
