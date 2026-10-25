import {hex as pnyxHex} from '@pnyx/crypto'
import {Either} from 'effect'

const hex = {
  string: (b: Uint8Array): string => pnyxHex.encode(b),
  bytes: (s: string): Uint8Array => Either.getOrThrow(pnyxHex.decode(s)),
}

import {type CardanoUri, parse as parseUri} from '@pnyx/links'
import {entropyToMnemonic, generateMnemonic, mnemonicToEntropy, validateMnemonic} from '@scure/bip39'
import {wordlist} from '@scure/bip39/wordlists/english.js'
import {Effect} from 'effect'
import {describe, expect, it} from 'vitest'

import {
  type Argon2idParams,
  type BackupPayload,
  buildEncryptedBackup,
  decryptEncryptedBackup,
  EncryptedBackupError,
  type EncryptedEnvelope,
  KDF_V1,
  parseEncryptedBackup,
} from './encrypted-backup'

// Tiny KDF profile so tests don't run a 256 MiB Argon2id derivation.
const TEST_KDF: Argon2idParams = {id: 'argon2id', m: 8, t: 1, p: 1, dkLen: 32}

const TWELVE_WORDS = generateMnemonic(wordlist, 128)
const TWENTY_FOUR_WORDS = generateMnemonic(wordlist, 256)
const PASSWORD = 'export-pass-1234'

// A deterministic 96-byte root xsk (kL‖kR‖chainCode) for root-key payloads.
const ROOT_XSK_HEX = hex.string(new Uint8Array(96).map((_, i) => (i * 7 + 1) & 0xff))

const rootPayload = (label?: string): BackupPayload => ({
  type: 'cardano-root',
  rootXskHex: ROOT_XSK_HEX,
  hrp: 'root_xsk',
  ...(label ? {label} : {}),
})

const mnemonicPayload = (mnemonic: string, label?: string): BackupPayload => ({
  type: 'mnemonic',
  entropyHex: hex.string(mnemonicToEntropy(mnemonic, wordlist)),
  ...(label ? {label} : {}),
})

const parseBackupUri = async (link: string) => {
  const parsed = await Effect.runPromise(parseUri(link as CardanoUri))
  if (parsed.authority !== 'backup') {
    throw new Error(`Expected backup authority, got ${parsed.authority}`)
  }
  return parsed
}

describe('encrypted-backup (CIP-0301)', () => {
  describe('mnemonic payload', () => {
    it('round-trips a 12-word mnemonic through the deep link', async () => {
      const {envelope, link} = await buildEncryptedBackup({
        payload: mnemonicPayload(TWELVE_WORDS),
        password: PASSWORD,
        params: TEST_KDF,
      })

      expect(link.startsWith('web+cardano://backup?')).toBe(true)
      expect(link).toContain('v=1')

      const uri = await parseBackupUri(link)
      expect(uri.authority).toBe('backup')
      const payload = await decryptEncryptedBackup(envelope, PASSWORD)

      expect(payload.type).toBe('mnemonic')
      if (payload.type !== 'mnemonic') throw new Error('unreachable')
      const mnemonic = entropyToMnemonic(hex.bytes(payload.entropyHex), wordlist)
      expect(mnemonic).toBe(TWELVE_WORDS)
      expect(validateMnemonic(mnemonic, wordlist)).toBe(true)
    })

    it('round-trips a 24-word mnemonic', async () => {
      const {envelope} = await buildEncryptedBackup({
        payload: mnemonicPayload(TWENTY_FOUR_WORDS, 'My Wallet'),
        password: PASSWORD,
        params: TEST_KDF,
      })
      const payload = await decryptEncryptedBackup(envelope, PASSWORD)
      if (payload.type !== 'mnemonic') throw new Error('unreachable')
      expect(entropyToMnemonic(hex.bytes(payload.entropyHex), wordlist)).toBe(TWENTY_FOUR_WORDS)
      expect(payload.label).toBe('My Wallet')
    })
  })

  describe('cardano-root payload', () => {
    it('round-trips a root xpriv with metadata through the deep link', async () => {
      const payload = rootPayload('Legacy wallet')
      const {envelope, link} = await buildEncryptedBackup({payload, password: PASSWORD, params: TEST_KDF})
      expect(envelope.payloadType).toBe('cardano-root')

      const uri = await parseBackupUri(link)
      expect(uri.authority).toBe('backup')
      const out = await decryptEncryptedBackup(envelope, PASSWORD)
      expect(out).toEqual(payload)
    })
  })

  describe('canonical JSON transport', () => {
    it('serialises the envelope verbatim into the JSON file transport', async () => {
      const {envelope, json} = await buildEncryptedBackup({
        payload: mnemonicPayload(TWELVE_WORDS),
        password: PASSWORD,
        params: TEST_KDF,
      })
      expect(JSON.parse(json)).toEqual(envelope)
      const payload = await decryptEncryptedBackup(envelope, PASSWORD)
      if (payload.type !== 'mnemonic') throw new Error('unreachable')
      expect(entropyToMnemonic(hex.bytes(payload.entropyHex), wordlist)).toBe(TWELVE_WORDS)
    })

    it('records the KDF params used in the envelope', async () => {
      const {envelope} = await buildEncryptedBackup({
        payload: mnemonicPayload(TWELVE_WORDS),
        password: PASSWORD,
        params: TEST_KDF,
      })
      expect(envelope.kdf).toEqual(TEST_KDF)
      expect(envelope.cipher).toBe('xchacha20poly1305')
      expect(envelope.v).toBe(1)
    })
  })

  describe('security', () => {
    it('fails decryption with the wrong password', async () => {
      const {envelope} = await buildEncryptedBackup({
        payload: mnemonicPayload(TWELVE_WORDS),
        password: PASSWORD,
        params: TEST_KDF,
      })
      await expect(decryptEncryptedBackup(envelope, 'wrong-password')).rejects.toBeInstanceOf(EncryptedBackupError)
    })

    it('fails closed when the ciphertext is tampered', async () => {
      const {envelope} = await buildEncryptedBackup({
        payload: mnemonicPayload(TWELVE_WORDS),
        password: PASSWORD,
        params: TEST_KDF,
      })
      const tampered: EncryptedEnvelope = {...envelope, ct: `${envelope.ct.slice(0, -2)}AA`}
      await expect(decryptEncryptedBackup(tampered, PASSWORD)).rejects.toBeInstanceOf(EncryptedBackupError)
    })

    it('produces a different envelope on each call (fresh salt + nonce)', async () => {
      const a = await buildEncryptedBackup({
        payload: mnemonicPayload(TWELVE_WORDS),
        password: PASSWORD,
        params: TEST_KDF,
      })
      const b = await buildEncryptedBackup({
        payload: mnemonicPayload(TWELVE_WORDS),
        password: PASSWORD,
        params: TEST_KDF,
      })
      expect(a.envelope.ct).not.toBe(b.envelope.ct)
      expect(a.envelope.salt).not.toBe(b.envelope.salt)
      expect(a.envelope.nonce).not.toBe(b.envelope.nonce)
    })

    it('rejects an empty export password on build', async () => {
      await expect(
        buildEncryptedBackup({payload: mnemonicPayload(TWELVE_WORDS), password: '', params: TEST_KDF}),
      ).rejects.toBeInstanceOf(EncryptedBackupError)
    })

    it('rejects a KDF memory cost above the fixed profile', () => {
      const envelope: EncryptedEnvelope = {
        v: 1,
        kdf: {id: 'argon2id', m: KDF_V1.m * 4, t: 3, p: 1, dkLen: 32},
        cipher: 'xchacha20poly1305',
        salt: 'AAAAAAAAAAAAAAAAAAAAAA',
        nonce: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        payloadType: 'mnemonic',
        ct: 'AAAA',
      }
      expect(() => parseEncryptedBackup(JSON.stringify(envelope))).toThrow(EncryptedBackupError)
    })

    it('rejects an unsupported version', async () => {
      const {json} = await buildEncryptedBackup({
        payload: mnemonicPayload(TWELVE_WORDS),
        password: PASSWORD,
        params: TEST_KDF,
      })
      const bumped = json.replace('"v":1', '"v":99')
      expect(() => parseEncryptedBackup(bumped)).toThrow(EncryptedBackupError)
    })

    it('rejects a payload whose type contradicts the envelope hint', async () => {
      // Encrypt a mnemonic payload but label the envelope as a root-key export.
      const {envelope} = await buildEncryptedBackup({
        payload: mnemonicPayload(TWELVE_WORDS),
        password: PASSWORD,
        params: TEST_KDF,
      })
      const lying: EncryptedEnvelope = {...envelope, payloadType: 'cardano-root'}
      await expect(decryptEncryptedBackup(lying, PASSWORD)).rejects.toBeInstanceOf(EncryptedBackupError)
    })
  })

  describe('QR feasibility', () => {
    // QR byte-mode capacity: ~2331 bytes at version 40 ECC-M. Both payload types
    // fit comfortably in a single symbol.
    const QR_ECC_M_BYTES = 2331

    it('keeps mnemonic and root-key links within a single QR', async () => {
      const mnemonic = await buildEncryptedBackup({
        payload: mnemonicPayload(TWENTY_FOUR_WORDS),
        password: PASSWORD,
        params: TEST_KDF,
      })
      expect(mnemonic.link.length).toBeLessThan(QR_ECC_M_BYTES)

      const {link} = await buildEncryptedBackup({payload: rootPayload(), password: PASSWORD, params: TEST_KDF})
      expect(link.length).toBeLessThan(QR_ECC_M_BYTES)
    })
  })

  describe('password encoding', () => {
    // CIP-0301 requires the password to be hashed as the UTF-8 bytes entered,
    // with no trim, case-fold or Unicode normalisation. The published vectors
    // carry these at the real 256 MiB profile for other implementations; these
    // run against production code at a tiny profile.
    const roundTrip = async (password: string) =>
      buildEncryptedBackup({payload: mnemonicPayload(TWELVE_WORDS), password, params: TEST_KDF})

    it('treats leading and trailing whitespace as password content', async () => {
      const {envelope} = await roundTrip('  spaced out  ')
      await expect(decryptEncryptedBackup(envelope, 'spaced out')).rejects.toBeInstanceOf(EncryptedBackupError)
      await expect(decryptEncryptedBackup(envelope, '  spaced out  ')).resolves.toMatchObject({type: 'mnemonic'})
    })

    it('treats an all-whitespace password as content', async () => {
      const {envelope} = await roundTrip('    ')
      await expect(decryptEncryptedBackup(envelope, '   ')).rejects.toBeInstanceOf(EncryptedBackupError)
      await expect(decryptEncryptedBackup(envelope, '    ')).resolves.toMatchObject({type: 'mnemonic'})
    })

    it('does not Unicode-normalise the password', async () => {
      const nfd = 'cafe\u0301-301'
      const nfc = 'caf\u00e9-301'
      expect(nfd.normalize('NFC')).toBe(nfc)
      const {envelope} = await roundTrip(nfd)
      await expect(decryptEncryptedBackup(envelope, nfc)).rejects.toBeInstanceOf(EncryptedBackupError)
      await expect(decryptEncryptedBackup(envelope, nfd)).resolves.toMatchObject({type: 'mnemonic'})
    })

    it('does not case-fold the password', async () => {
      const {envelope} = await roundTrip('MiXeD-Case-301')
      await expect(decryptEncryptedBackup(envelope, 'mixed-case-301')).rejects.toBeInstanceOf(EncryptedBackupError)
      await expect(decryptEncryptedBackup(envelope, 'MiXeD-Case-301')).resolves.toMatchObject({type: 'mnemonic'})
    })
  })

  it('exposes the one documented KDF profile', () => {
    expect(KDF_V1).toEqual({id: 'argon2id', m: 262144, t: 3, p: 1, dkLen: 32})
  })

  it('refuses a weaker KDF profile than the fixed one, including the withdrawn 64 MiB level', () => {
    const envelope: EncryptedEnvelope = {
      v: 1,
      kdf: {id: 'argon2id', m: 65536, t: 3, p: 1, dkLen: 32},
      cipher: 'xchacha20poly1305',
      salt: 'AAAAAAAAAAAAAAAAAAAAAA',
      nonce: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      payloadType: 'mnemonic',
      ct: 'AAAA',
    }
    expect(() => parseEncryptedBackup(JSON.stringify(envelope))).toThrow(EncryptedBackupError)
  })
})
