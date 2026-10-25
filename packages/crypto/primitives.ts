/**
 * Cryptographic primitives, Effect-flavored.
 *
 * Wraps audited @noble implementations with typed errors. Only the surface the
 * app actually uses lives here — add primitives when a consumer needs them,
 * not speculatively.
 *
 * @module
 */

import {xchacha20poly1305} from '@noble/ciphers/chacha.js'
import {argon2idAsync} from '@noble/hashes/argon2.js'
import {hkdf} from '@noble/hashes/hkdf.js'
import {pbkdf2Async} from '@noble/hashes/pbkdf2.js'
import {sha256, sha512} from '@noble/hashes/sha2.js'
import {randomBytes as nobleRandomBytes} from '@noble/hashes/utils.js'
import {Effect} from 'effect'
import {CryptoError} from './errors.js'

/** Argon2id cost parameters. */
export type Argon2idParams = {
  /** Memory cost in KiB. */
  readonly m: number
  /** Time cost (iterations). */
  readonly t: number
  /** Parallelism. */
  readonly p: number
  /** Output key length in bytes. */
  readonly dkLen: number
}

/** Cryptographically secure random bytes from the platform CSPRNG. */
export const randomBytes = (length: number): Effect.Effect<Uint8Array, CryptoError> =>
  Effect.try({
    try: () => nobleRandomBytes(length),
    catch: (e) =>
      new CryptoError({
        message: `CSPRNG unavailable: ${e instanceof Error ? e.message : String(e)}`,
        cause: e,
      }),
  })

/** Derive a key from a password with Argon2id (memory-hard KDF). */
export const argon2id = (
  password: Uint8Array,
  salt: Uint8Array,
  params: Argon2idParams,
): Effect.Effect<Uint8Array, CryptoError> =>
  Effect.tryPromise({
    try: () => argon2idAsync(password, salt, params),
    catch: (e) =>
      new CryptoError({
        message: `Argon2id derivation failed: ${e instanceof Error ? e.message : String(e)}`,
        cause: e,
      }),
  })

/** PBKDF2 parameters. */
export type Pbkdf2Params = {
  /** HMAC hash function. */
  readonly hash: 'sha256' | 'sha512'
  /** Iteration count. */
  readonly c: number
  /** Output key length in bytes. */
  readonly dkLen: number
}

/** Derive a key from a password with PBKDF2 (RFC 8018). */
export const pbkdf2 = (
  password: Uint8Array,
  salt: Uint8Array,
  params: Pbkdf2Params,
): Effect.Effect<Uint8Array, CryptoError> =>
  Effect.tryPromise({
    try: () =>
      pbkdf2Async(params.hash === 'sha512' ? sha512 : sha256, password, salt, {c: params.c, dkLen: params.dkLen}),
    catch: (e) =>
      new CryptoError({
        message: `PBKDF2 derivation failed: ${e instanceof Error ? e.message : String(e)}`,
        cause: e,
      }),
  })

/**
 * Derive a key with HKDF-SHA256 (RFC 5869). `info` provides domain separation;
 * `salt` is optional and defaults to the RFC's zero-filled hash-length salt.
 */
export const hkdfSha256 = (
  ikm: Uint8Array,
  info: Uint8Array,
  length: number,
  salt?: Uint8Array,
): Effect.Effect<Uint8Array, CryptoError> =>
  Effect.try({
    try: () => hkdf(sha256, ikm, salt, info, length),
    catch: (e) =>
      new CryptoError({
        message: `HKDF-SHA256 derivation failed: ${e instanceof Error ? e.message : String(e)}`,
        cause: e,
      }),
  })

/** Encrypt with XChaCha20-Poly1305 (24-byte nonce, authenticated). */
export const xchacha20poly1305Encrypt = (
  key: Uint8Array,
  nonce: Uint8Array,
  plaintext: Uint8Array,
  aad?: Uint8Array,
): Effect.Effect<Uint8Array, CryptoError> =>
  Effect.try({
    try: () => xchacha20poly1305(key, nonce, aad).encrypt(plaintext),
    catch: (e) =>
      new CryptoError({
        message: `XChaCha20-Poly1305 encryption failed: ${e instanceof Error ? e.message : String(e)}`,
        cause: e,
      }),
  })

/** Decrypt with XChaCha20-Poly1305; fails on auth-tag mismatch (tampered or wrong key). */
export const xchacha20poly1305Decrypt = (
  key: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
  aad?: Uint8Array,
): Effect.Effect<Uint8Array, CryptoError> =>
  Effect.try({
    try: () => xchacha20poly1305(key, nonce, aad).decrypt(ciphertext),
    catch: (e) =>
      new CryptoError({
        message: `XChaCha20-Poly1305 decryption failed: ${e instanceof Error ? e.message : String(e)}`,
        cause: e,
      }),
  })
