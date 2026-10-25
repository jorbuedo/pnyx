/**
 * The CPace / CodeEntry pairing layer.
 *
 * Untested in this repo until 2026-08-05, because until then it had never run: pairing failed earlier,
 * at `ThpPairingRequest` (see `protobuf.ts` — every THP message was going out as type `0x0000`), so
 * `elligator2`, `getCpaceHostKeys` and `validateCodeEntryTag` were unreachable. They now execute
 * against real firmware, which makes coverage here worth having rather than theoretical.
 *
 * @module
 */

import {describe, expect, it} from 'vitest'
import {bytesToHex, concatBytes, hexToBytes, utf8ToBytes} from '../bytes'
import {bigEndianBytesToBigInt, elligator2, sha256} from './crypto'
import {getCpaceHostKeys, getSharedSecret, validateCodeEntryTag} from './pairing'
import type {ThpHandshakeCredentials} from './types'

/**
 * From trezor-suite `packages/protocol/tests/protocol-thp/curve25519.fixtures.ts`.
 *
 * The generator these produce is the one input CPace has that nothing else in THP uses, so a
 * divergence here would only ever surface as a tag the device rejects with no other symptom.
 */
const ELLIGATOR2_VECTORS: readonly (readonly [string, string])[] = [
  [
    '0000000000000000000000000000000000000000000000000000000000000000',
    '0000000000000000000000000000000000000000000000000000000000000000',
  ],
  [
    '66665895c5bc6e44ba8d65fd9307092e3244bf2c18877832bd568cb3a2d38a12',
    '04d44290d13100b2c25290c9343d70c12ed4813487a07ac1176daa5925e7975e',
  ],
  [
    '673a505e107189ee54ca93310ac42e4545e9e59050aaac6f8b5f64295c8ec02f',
    '242ae39ef158ed60f20b89396d7d7eef5374aba15dc312a6aea6d1e57cacf85e',
  ],
  [
    '990b30e04e1c3620b4162b91a33429bddb9f1b70f1da6e5f76385ed3f98ab131',
    '998e98021eb4ee653effaa992f3fae4b834de777a953271baaa1fa3fef6b776e',
  ],
  [
    '341a60725b482dd0de2e25a585b208433044bc0a1ba762442df3a0e888ca063c',
    '683a71d7fca4fc6ad3d4690108be808c2e50a5af3174486741d0a83af52aeb01',
  ],
  [
    '922688fa428d42bc1fa8806998fbc5959ae801817e85a42a45e8ec25a0d7541a',
    '696f341266c64bcfa7afa834f8c34b2730be11c932e08474d1a22f26ed82410b',
  ],
  [
    '0d3b0eb88b74ed13d5f6a130e03c4ad607817057dc227152827c0506a538bb3a',
    '0b00df174d9fb0b6ee584d2cf05613130bad18875268c38b377e86dfefef177f',
  ],
  [
    '01a3ea5658f4e00622eeacf724e0bd82068992fae66ed2b04a8599be16662e35',
    '7ae4c58bc647b5646c9f5ae4c2554ccbf7c6e428e7b242a574a5a9c293c21f7e',
  ],
  [
    '1d991dff82a84afe97874c0f03a60a56616a15212fbe10d6c099aa3afcfabe35',
    'f81f235696f81df90ac2fc861ceee517bff611a394b5be5faaee45584642fb0a',
  ],
  [
    '185435d2b005a3b63f3187e64a1ef3582533e1958d30e4e4747b4d1d3376c728',
    'f938b1b320abb0635930bd5d7ced45ae97fa8b5f71cc21d87b4c60905c125d34',
  ],
]

describe('elligator2', () => {
  it('matches upstream on every vector', () => {
    for (const [input, expected] of ELLIGATOR2_VECTORS) {
      expect(bytesToHex(elligator2(hexToBytes(input))), input).toBe(expected)
    }
  })
})

describe('getCpaceHostKeys', () => {
  const handshakeHash = new Uint8Array(32).fill(9)
  const fixedRandom = (n: number) => new Uint8Array(n).fill(3)

  it('is deterministic for a given code, hash and private key', () => {
    const a = getCpaceHostKeys(utf8ToBytes('123456'), handshakeHash, fixedRandom)
    const b = getCpaceHostKeys(utf8ToBytes('123456'), handshakeHash, fixedRandom)
    expect(bytesToHex(a.publicKey)).toBe(bytesToHex(b.publicKey))
  })

  it('derives a different generator for a different code', () => {
    // The whole point of CPace: the shared secret is only reachable by someone holding the same code.
    const a = getCpaceHostKeys(utf8ToBytes('123456'), handshakeHash, fixedRandom)
    const b = getCpaceHostKeys(utf8ToBytes('123457'), handshakeHash, fixedRandom)
    expect(bytesToHex(a.publicKey)).not.toBe(bytesToHex(b.publicKey))
  })

  it('derives a different generator for a different handshake hash', () => {
    // Binds the pairing to this channel, so a tag cannot be replayed onto another handshake.
    const a = getCpaceHostKeys(utf8ToBytes('123456'), handshakeHash, fixedRandom)
    const b = getCpaceHostKeys(utf8ToBytes('123456'), new Uint8Array(32).fill(10), fixedRandom)
    expect(bytesToHex(a.publicKey)).not.toBe(bytesToHex(b.publicKey))
  })

  it('agrees with the peer on the shared secret', () => {
    // Both sides run X25519 over the same code-derived generator, so the tags must match.
    const generator = elligator2(new Uint8Array(32).fill(5))
    const host = getCpaceHostKeys(utf8ToBytes('123456'), handshakeHash, () => new Uint8Array(32).fill(1))
    const peer = getCpaceHostKeys(utf8ToBytes('123456'), handshakeHash, () => new Uint8Array(32).fill(2))
    expect(bytesToHex(getSharedSecret(peer.publicKey, host.privateKey))).toBe(
      bytesToHex(getSharedSecret(host.publicKey, peer.privateKey)),
    )
    expect(generator).toHaveLength(32)
  })
})

describe('validateCodeEntryTag', () => {
  const handshakeHash = new Uint8Array(32).fill(4)
  const codeEntryChallenge = new Uint8Array(32).fill(6)
  const secret = new Uint8Array(32).fill(8)

  /** The value the device would show: SHA-256(CodeEntry ‖ h ‖ secret ‖ challenge) mod 1e6. */
  const expectedCode = (): string => {
    const input = concatBytes(new Uint8Array([2]), handshakeHash, secret, codeEntryChallenge)
    return (bigEndianBytesToBigInt(sha256(input)) % 1000000n).toString()
  }

  const credentials = (): ThpHandshakeCredentials =>
    ({
      handshakeHash,
      handshakeCommitment: sha256(secret),
      codeEntryChallenge,
    }) as unknown as ThpHandshakeCredentials

  it('accepts a self-consistent commitment and code', () => {
    expect(() => validateCodeEntryTag(credentials(), expectedCode(), bytesToHex(secret))).not.toThrow()
  })

  it('rejects a secret whose commitment does not match', () => {
    // The commitment is what stops the device swapping its secret after seeing our challenge.
    const wrong = {...credentials(), handshakeCommitment: sha256(new Uint8Array(32).fill(99))}
    expect(() => validateCodeEntryTag(wrong as ThpHandshakeCredentials, expectedCode(), bytesToHex(secret))).toThrow(
      /HP5: commitment mismatch/,
    )
  })

  it('rejects a mistyped code', () => {
    const wrongCode = String((Number(expectedCode()) + 1) % 1000000)
    expect(() => validateCodeEntryTag(credentials(), wrongCode, bytesToHex(secret))).toThrow(/HP5: code mismatch/)
  })

  it('rejects a code that is right for a different challenge', () => {
    // Binds the code to our challenge, so a replayed transcript does not verify.
    const other = {...credentials(), codeEntryChallenge: new Uint8Array(32).fill(7)}
    expect(() => validateCodeEntryTag(other as ThpHandshakeCredentials, expectedCode(), bytesToHex(secret))).toThrow(
      /HP5: code mismatch/,
    )
  })
})
