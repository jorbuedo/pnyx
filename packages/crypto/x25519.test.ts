// X25519 against the RFC 7748 test vectors.
//
// @noble/curves is itself tested against these vectors, so what this file really guards is *our*
// wiring: that we call scalarMult/getPublicKey/getSharedSecret with the right arguments in the
// right order, that a dependency bump doesn't change behaviour underneath us, and that the
// low-order rejection stays a typed failure rather than a zero secret.
import {Effect, Either} from 'effect'
import {describe, expect, it} from 'vitest'

import {CryptoError} from './errors.js'
import {x25519, x25519PublicKey, x25519SharedSecret} from './x25519.js'

const h = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, 'hex'))
const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex')

// RFC 7748 §6.1
const ALICE_SK = h('77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a')
const ALICE_PK = '8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a'
const BOB_SK = h('5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb')
const BOB_PK = 'de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f'
const SHARED = '4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742'

const run = <A, E>(e: Effect.Effect<A, E>): Either.Either<A, E> => Effect.runSync(Effect.either(e))

describe('x25519PublicKey — RFC 7748 §6.1', () => {
  it("derives Alice's and Bob's public keys", () => {
    expect(hex(x25519PublicKey(ALICE_SK))).toBe(ALICE_PK)
    expect(hex(x25519PublicKey(BOB_SK))).toBe(BOB_PK)
  })

  it('is 32 bytes and deterministic', () => {
    expect(x25519PublicKey(ALICE_SK).length).toBe(32)
    expect(hex(x25519PublicKey(ALICE_SK))).toBe(hex(x25519PublicKey(ALICE_SK)))
  })
})

describe('x25519 scalar multiplication — RFC 7748 §5.2', () => {
  it('matches vector 1', () => {
    const out = x25519.scalarMult(
      h('a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4'),
      h('e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c'),
    )
    expect(hex(out)).toBe('c3da55379de9c6908e94ea4df28d084f32eccf03491c71f754b4075577a28552')
  })
})

describe('x25519SharedSecret', () => {
  it('agrees in both directions on the RFC 7748 §6.1 secret', () => {
    const ab = run(x25519SharedSecret(ALICE_SK, h(BOB_PK)))
    const ba = run(x25519SharedSecret(BOB_SK, h(ALICE_PK)))
    expect(Either.isRight(ab)).toBe(true)
    expect(Either.isRight(ba)).toBe(true)
    if (!Either.isRight(ab) || !Either.isRight(ba)) return
    expect(hex(ab.right)).toBe(SHARED)
    expect(hex(ba.right)).toBe(SHARED)
  })

  it('gives a different secret for a different peer', () => {
    const other = x25519PublicKey(h('0101010101010101010101010101010101010101010101010101010101010101'))
    const ab = run(x25519SharedSecret(ALICE_SK, other))
    expect(Either.isRight(ab)).toBe(true)
    if (!Either.isRight(ab)) return
    expect(hex(ab.right)).not.toBe(SHARED)
  })

  // A low-order peer key drives the output to all zeros. Returning that would hand two unrelated
  // parties an identical "shared secret", so it must be a failure, not a value.
  it.each([
    ['all-zero', new Uint8Array(32)],
    ['order-1 point', h('0100000000000000000000000000000000000000000000000000000000000000')],
  ])('rejects a %s peer key as a typed error', (_label, peer) => {
    const result = run(x25519SharedSecret(ALICE_SK, peer))
    expect(Either.isLeft(result)).toBe(true)
    if (!Either.isLeft(result)) return
    expect(result.left).toBeInstanceOf(CryptoError)
    expect(result.left.message).toMatch(/X25519 shared-secret computation failed/)
  })

  it('rejects a malformed peer key length', () => {
    const result = run(x25519SharedSecret(ALICE_SK, new Uint8Array(31).fill(7)))
    expect(Either.isLeft(result)).toBe(true)
  })
})
