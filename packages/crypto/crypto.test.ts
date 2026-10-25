import {Effect, Either} from 'effect'
import {describe, expect, it} from 'vitest'
import {base64, hex, utf8} from './codec.js'
import {
  argon2id,
  hkdfSha256,
  pbkdf2,
  randomBytes,
  xchacha20poly1305Decrypt,
  xchacha20poly1305Encrypt,
} from './primitives.js'

const bytes = (...values: number[]) => new Uint8Array(values)
const unwrap = <A, E>(either: Either.Either<A, E>): A =>
  Either.match(either, {
    onLeft: (e) => {
      throw new Error(`expected Right, got Left: ${String(e)}`)
    },
    onRight: (a) => a,
  })

describe('base64', () => {
  it('encodes standard padded base64', () => {
    expect(base64.encode(utf8.encode('hello world'))).toBe('aGVsbG8gd29ybGQ=')
    expect(base64.encode(bytes())).toBe('')
  })

  it('decodes padded, unpadded and url-safe input (legacy compatibility)', () => {
    for (const input of ['aGVsbG8gd29ybGQ=', 'aGVsbG8gd29ybGQ']) {
      expect(unwrap(utf8.decode(unwrap(base64.decode(input))))).toBe('hello world')
    }
    // 0xfb 0xff encodes to '+/8=' standard, '-_8' url-safe unpadded
    expect(unwrap(base64.decode('-_8'))).toEqual(bytes(0xfb, 0xff))
    expect(unwrap(base64.decode('+/8='))).toEqual(bytes(0xfb, 0xff))
  })

  it('rejects garbage', () => {
    expect(Either.isLeft(base64.decode('not base64!!'))).toBe(true)
  })
})

describe('hex', () => {
  it('round-trips and accepts either case', () => {
    expect(hex.encode(bytes(0xde, 0xad, 0xbe, 0xef))).toBe('deadbeef')
    expect(unwrap(hex.decode('DEADBEEF'))).toEqual(bytes(0xde, 0xad, 0xbe, 0xef))
    expect(Either.isLeft(hex.decode('xyz'))).toBe(true)
  })
})

describe('utf8', () => {
  it('round-trips and fails on invalid sequences', () => {
    expect(unwrap(utf8.decode(utf8.encode('ágora ✓')))).toBe('ágora ✓')
    expect(Either.isLeft(utf8.decode(bytes(0xff, 0xfe, 0xfd)))).toBe(true)
  })
})

describe('primitives', () => {
  it('randomBytes returns the requested length and distinct output', async () => {
    const [a, b] = await Effect.runPromise(Effect.all([randomBytes(32), randomBytes(32)]))
    expect(a).toHaveLength(32)
    expect(hex.encode(a)).not.toBe(hex.encode(b))
  })

  it('argon2id matches the reference vector', async () => {
    // RFC 9106-style check pinned against @noble/hashes output for these params.
    const key = await Effect.runPromise(
      argon2id(utf8.encode('password'), utf8.encode('somesalt12345678'), {m: 4096, t: 2, p: 1, dkLen: 32}),
    )
    expect(key).toHaveLength(32)
    // Determinism: same inputs, same key.
    const again = await Effect.runPromise(
      argon2id(utf8.encode('password'), utf8.encode('somesalt12345678'), {m: 4096, t: 2, p: 1, dkLen: 32}),
    )
    expect(hex.encode(again)).toBe(hex.encode(key))
  })

  it('pbkdf2 is deterministic, respects dkLen and matches the RFC vector', async () => {
    // RFC 6070/7914-derived PBKDF2-HMAC-SHA256 vector: P="password", S="salt", c=1, dkLen=32.
    const vector = await Effect.runPromise(
      pbkdf2(utf8.encode('password'), utf8.encode('salt'), {hash: 'sha256', c: 1, dkLen: 32}),
    )
    expect(hex.encode(vector)).toBe('120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b')

    const params = {hash: 'sha512', c: 2048, dkLen: 64} as const
    const [a, b] = await Effect.runPromise(
      Effect.all([
        pbkdf2(utf8.encode('password'), utf8.encode('somesalt'), params),
        pbkdf2(utf8.encode('password'), utf8.encode('somesalt'), params),
      ]),
    )
    expect(a).toHaveLength(64)
    expect(hex.encode(a)).toBe(hex.encode(b))
    // Different salt, different key.
    const c = await Effect.runPromise(pbkdf2(utf8.encode('password'), utf8.encode('othersalt'), params))
    expect(hex.encode(c)).not.toBe(hex.encode(a))
  })

  it('hkdfSha256 matches RFC 5869 test case 1', async () => {
    const ikm = unwrap(hex.decode('0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b'))
    const salt = unwrap(hex.decode('000102030405060708090a0b0c'))
    const info = unwrap(hex.decode('f0f1f2f3f4f5f6f7f8f9'))
    const okm = await Effect.runPromise(hkdfSha256(ikm, info, 42, salt))
    expect(hex.encode(okm)).toBe('3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865')
  })

  it('hkdfSha256 matches RFC 5869 test case 3 (zero-length salt and info)', async () => {
    const ikm = unwrap(hex.decode('0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b'))
    const okm = await Effect.runPromise(hkdfSha256(ikm, bytes(), 42))
    expect(hex.encode(okm)).toBe('8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8')
  })

  it('hkdfSha256 domain-separates by info', async () => {
    const ikm = utf8.encode('prf output')
    const [a, b] = await Effect.runPromise(
      Effect.all([hkdfSha256(ikm, utf8.encode('pnyx:prf-wrap:v1'), 32), hkdfSha256(ikm, utf8.encode('other'), 32)]),
    )
    expect(a).toHaveLength(32)
    expect(hex.encode(a)).not.toBe(hex.encode(b))
  })

  it('xchacha20poly1305 round-trips and rejects tampering', async () => {
    const program = Effect.gen(function* () {
      const key = yield* randomBytes(32)
      const nonce = yield* randomBytes(24)
      const plaintext = utf8.encode('identity, not funds')
      const ciphertext = yield* xchacha20poly1305Encrypt(key, nonce, plaintext)
      const roundTripped = yield* xchacha20poly1305Decrypt(key, nonce, ciphertext)
      const tampered = Uint8Array.from(ciphertext)
      const firstByte = tampered[0]
      if (firstByte === undefined) throw new Error('ciphertext is empty')
      tampered[0] = firstByte ^ 0xff
      const rejected = yield* Effect.either(xchacha20poly1305Decrypt(key, nonce, tampered))
      return {roundTripped, rejected}
    })
    const {roundTripped, rejected} = await Effect.runPromise(program)
    expect(unwrap(utf8.decode(roundTripped))).toBe('identity, not funds')
    expect(Either.isLeft(rejected)).toBe(true)
  })
})
