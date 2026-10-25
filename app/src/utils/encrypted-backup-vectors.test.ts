/**
 * Verifier for the published CIP-0301 interop vectors.
 *
 * The vectors use the spec's real KDF profile (256 MiB Argon2id, ~5s per
 * derivation on a desktop and far worse under coverage instrumentation), so
 * deriving a key per vector is not viable here. Instead the vectors publish
 * `derivedKeyHex`, which lets this suite verify everything downstream of the
 * KDF for real: the nonce handling, the AEAD tag, the ciphertext bytes and the
 * payload serialisation. Set `CIP301_FULL=1` to additionally run Argon2id and
 * confirm each published `derivedKeyHex` really comes from its password/salt.
 *
 * The password-encoding rules (no trim, no Unicode normalisation) are pinned
 * against production code at a tiny KDF profile in encrypted-backup.test.ts;
 * the vectors carry them at full strength for other implementations.
 */
import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {argon2id, base64, hex, utf8, xchacha20poly1305Decrypt} from '@pnyx/crypto'
import {type CardanoUri, parse as parseUri} from '@pnyx/links'
import {Effect, Either} from 'effect'
import {describe, expect, it} from 'vitest'
import {
  type Argon2idParams,
  buildBackupLink,
  type EncryptedEnvelope,
  KDF_V1,
  parseEncryptedBackup,
} from './encrypted-backup'

type Vector = {
  description: string
  inputs: {
    password: string
    saltHex: string
    nonceHex: string
    kdf: Argon2idParams
    payload: Record<string, string>
    plaintextHex: string
  }
  derivedKeyHex: string
  envelope: EncryptedEnvelope
  link: string
}
type Rejection = {
  description: string
  reason: string
  password?: string
  envelope: EncryptedEnvelope
}

const CIP_DIR = resolve(__dirname, '../../../docs/cips/CIP-0301-encrypted-wallet-export')
const {kdf, vectors, rejections} = JSON.parse(readFileSync(resolve(CIP_DIR, 'test-vectors.json'), 'utf8')) as {
  kdf: Argon2idParams
  vectors: Vector[]
  rejections: Rejection[]
}

const [baseVector] = vectors
if (!baseVector) throw new Error('test-vectors.json publishes no vectors')

const bytes = (h: string): Uint8Array => Either.getOrThrowWith(hex.decode(h), (e) => new Error(e.message))
const b64url = (s: string): Uint8Array => Either.getOrThrowWith(base64.decode(s), (e) => new Error(e.message))

describe('CIP-0301 published vectors', () => {
  it('declares the one v1 KDF profile the implementation uses', () => {
    expect(kdf).toEqual(KDF_V1)
  })

  it('covers both payload types', () => {
    expect(new Set(vectors.map((v) => v.envelope.payloadType))).toEqual(new Set(['mnemonic', 'cardano-root']))
  })

  it('never reuses a key or a nonce across vectors', () => {
    expect(new Set(vectors.map((v) => v.derivedKeyHex)).size).toBe(vectors.length)
    expect(new Set(vectors.map((v) => v.inputs.nonceHex)).size).toBe(vectors.length)
  })

  it.each(vectors.map((v) => [v.description, v] as const))('parses and validates: %s', (_d, v) => {
    expect(parseEncryptedBackup(JSON.stringify(v.envelope))).toEqual(v.envelope)
    expect(v.envelope.kdf).toEqual(KDF_V1)
  })

  it.each(
    vectors.map((v) => [v.description, v] as const),
  )('decrypts to its published plaintext under its published key: %s', async (_d, v) => {
    const key = bytes(v.derivedKeyHex)
    expect(key).toHaveLength(32)
    const plaintext = await Effect.runPromise(
      xchacha20poly1305Decrypt(key, b64url(v.envelope.nonce), b64url(v.envelope.ct)),
    )
    expect(hex.encode(plaintext)).toBe(v.inputs.plaintextHex)
    expect(JSON.parse(Either.getOrThrowWith(utf8.decode(plaintext), (e) => new Error(e.message)))).toEqual(
      v.inputs.payload,
    )
  })

  it('publishes a link that round-trips to the same envelope', async () => {
    for (const v of vectors) {
      const uri = await Effect.runPromise(parseUri(v.link as CardanoUri))
      expect(uri.authority).toBe('backup')
      if (uri.authority !== 'backup') throw new Error('unreachable')
      expect(parseEncryptedBackup(uri)).toEqual(v.envelope)
    }
  })

  // ⚠️ Byte equality on the link, not just a round trip. Until 2026-10-10 the app built
  // `?enc=…&v=1` while the vectors publish `?v=1&enc=…`: both parse, because URLSearchParams does
  // not care about order, so nothing here failed — a round-trip assertion cannot see a divergence
  // it then parses away. The exporter emits the published form now, and this is what holds it.
  it.each(vectors.map((v) => [v.description, v] as const))('builds the published link byte for byte: %s', (_d, v) => {
    expect(buildBackupLink(v.envelope)).toBe(v.link)
  })
})

describe('CIP-0301 published rejections', () => {
  const atParse = new Set(['kdf-params-rejected', 'cipher-unrecognised', 'version-unrecognised'])

  it('states a reason for every rejection', () => {
    expect(rejections.length).toBeGreaterThan(0)
    for (const r of rejections) expect(r.reason).toBeTruthy()
  })

  it.each(
    rejections.filter((r) => atParse.has(r.reason)).map((r) => [r.description, r] as const),
  )('refuses before deriving: %s', (_d, r) => {
    expect(() => parseEncryptedBackup(JSON.stringify(r.envelope))).toThrow()
  })

  it('refuses a ciphertext mutated by one bit, under the correct key', async () => {
    const mutated = rejections.find((r) => r.description.startsWith('ciphertext mutated'))
    expect(mutated).toBeDefined()
    if (!mutated) return
    const key = bytes(baseVector.derivedKeyHex)
    const result = await Effect.runPromise(
      Effect.either(xchacha20poly1305Decrypt(key, b64url(mutated.envelope.nonce), b64url(mutated.envelope.ct))),
    )
    expect(Either.isLeft(result)).toBe(true)
  })

  it('publishes a payloadType-mismatch case whose plaintext really disagrees with its envelope', async () => {
    const mismatch = rejections.find((r) => r.reason === 'payload-type-mismatch')
    expect(mismatch).toBeDefined()
    if (!mismatch) return
    const plaintext = await Effect.runPromise(
      xchacha20poly1305Decrypt(
        bytes(baseVector.derivedKeyHex),
        b64url(mismatch.envelope.nonce),
        b64url(mismatch.envelope.ct),
      ),
    )
    const payload = JSON.parse(Either.getOrThrowWith(utf8.decode(plaintext), (e) => new Error(e.message)))
    expect(payload.type).not.toBe(mismatch.envelope.payloadType)
  })
})

describe.runIf(process.env.CIP301_FULL === '1')('CIP-0301 vectors, full KDF', () => {
  it.each(vectors.map((v) => [v.description, v] as const))(
    'derives the published key from its password and salt: %s',
    async (_d, v) => {
      const derived = await Effect.runPromise(
        argon2id(utf8.encode(v.inputs.password), bytes(v.inputs.saltHex), {
          m: v.inputs.kdf.m,
          t: v.inputs.kdf.t,
          p: v.inputs.kdf.p,
          dkLen: v.inputs.kdf.dkLen,
        }),
      )
      expect(hex.encode(derived)).toBe(v.derivedKeyHex)
    },
    600_000,
  )
})
