/**
 * Typed errors for the crypto package.
 *
 * @module
 */

import {Data} from 'effect'

/** Decoding text into bytes failed (bad alphabet, bad length, …). */
export class CodecError extends Data.TaggedError('CodecError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

/** A cryptographic operation failed (bad key/nonce length, auth tag mismatch, KDF failure, …). */
export class CryptoError extends Data.TaggedError('CryptoError')<{
  readonly message: string
  readonly cause?: unknown
}> {}
