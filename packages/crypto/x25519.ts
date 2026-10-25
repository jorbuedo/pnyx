/**
 * X25519 key agreement (RFC 7748), backed by @noble/curves.
 *
 * Split across two shapes on purpose, matching the rest of the package: deriving a public key
 * cannot fail for a well-formed scalar, so it is a pure function like the helpers in `curves.ts`;
 * computing a shared secret **can** fail, so it is Effect-returning like the primitives in
 * `primitives.ts`.
 *
 * The failure is not hypothetical. X25519 maps low-order peer public keys to an all-zero shared
 * secret, which would silently give two parties the same "secret" regardless of their own keys —
 * so a peer key must be rejected rather than accepted with a zero secret. @noble enforces this
 * (RFC 7748 §6.1's contributory-behaviour check) and we surface it as a typed error.
 *
 * @module
 */

import {x25519 as nobleX25519} from '@noble/curves/ed25519.js'
import {Effect} from 'effect'
import {CryptoError} from './errors.js'

/** The raw curve object, for callers that need point ops beyond the helpers below. */
export {nobleX25519 as x25519}

/**
 * 32-byte X25519 public key for a 32-byte scalar.
 *
 * Pure: X25519 clamps the scalar, so every 32-byte input is a valid private key — there is no
 * weak-key rejection to perform on our own side. Passing anything other than 32 bytes is a
 * programming error and throws, the same contract as `curves.ts`.
 */
export const x25519PublicKey = (scalar: Uint8Array): Uint8Array => nobleX25519.getPublicKey(scalar)

/**
 * ECDH shared secret between our scalar and a peer's public key.
 *
 * Fails with a `CryptoError` when the peer key is low-order (all-zero output) or malformed —
 * never returns a zero secret. Both directions of a pair produce the same value, so this is the
 * static-static ECDH used for DM message keys; feed the result through `hkdfSha256` rather than
 * using it as a key directly, since the raw output is a curve point, not uniform bytes.
 */
export const x25519SharedSecret = (
  scalar: Uint8Array,
  peerPublicKey: Uint8Array,
): Effect.Effect<Uint8Array, CryptoError> =>
  Effect.try({
    try: () => nobleX25519.getSharedSecret(scalar, peerPublicKey),
    catch: (e) =>
      new CryptoError({
        message: `X25519 shared-secret computation failed: ${e instanceof Error ? e.message : String(e)}`,
        cause: e,
      }),
  })
