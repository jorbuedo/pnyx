/**
 * THP Noise_XX handshake and pairing tag validation.
 *
 * Implements the full Noise_XX handshake protocol and all pairing
 * verification methods (CodeEntry, QrCode, NFC).
 *
 * @module
 */

import {getLogger} from '@pnyx/logger'
import {bytesEqual, bytesToHex, concatBytes, hexToBytes, utf8ToBytes} from '../bytes'
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  bigEndianBytesToBigInt,
  curve25519,
  elligator2,
  getCurve25519KeyPair,
  getIvFromNonce,
  hashOfTwo,
  hkdf,
  sha256,
  sha512,
} from './crypto'
import type {ThpState} from './state'
import type {ThpCredentials, ThpHandshakeCredentials, ThpHandshakeInitResponse} from './types'

const logger = getLogger('hardware')

const getProtocolName = (): Uint8Array => concatBytes(utf8ToBytes('Noise_XX_25519_AESGCM_SHA256'), new Uint8Array(4))

export const getHandshakeHash = (deviceProperties: Uint8Array): Uint8Array =>
  hashOfTwo(getProtocolName(), deviceProperties)

export const findKnownPairingCredentials = (
  knownCredentials: ThpCredentials[],
  trezorMaskedStaticPubkey: Uint8Array,
  trezorEphemeralPubkey: Uint8Array,
): ThpCredentials[] =>
  knownCredentials.filter((c) => {
    try {
      const trezorStaticPubkey = hexToBytes(c.trezor_static_public_key)
      const h = hashOfTwo(trezorStaticPubkey, trezorEphemeralPubkey)
      return bytesEqual(trezorMaskedStaticPubkey, curve25519(h, trezorStaticPubkey))
    } catch (e: unknown) {
      // Failing closed is right for a pairing check, and it means a key that does not match and
      // a computation that threw are the same verdict. Only this line separates them.
      logger.warn('Pairing credential check threw; treating it as no match', {
        origin: 'trezor/thp-pairing',
        error: String(e),
      })
      return false
    }
  })

export const getTrezorState = (credentials: ThpHandshakeCredentials, payload: Uint8Array): 0 | 1 => {
  const decrypted = aesGcmDecrypt(
    credentials.trezorKey,
    new Uint8Array(12),
    new Uint8Array(0),
    payload.subarray(0, 1),
    payload.subarray(1, 17),
  )
  return decrypted[0] as 0 | 1
}

type Curve25519KeyPair = ReturnType<typeof getCurve25519KeyPair>

export const handleHandshakeInit = ({
  handshakeInitResponse,
  thpState,
  knownCredentials,
  hostEphemeralKeys,
  tryToUnlock,
  protobufEncoder,
  randomBytes,
}: {
  handshakeInitResponse: ThpHandshakeInitResponse
  thpState: ThpState
  knownCredentials: ThpCredentials[]
  hostEphemeralKeys: Curve25519KeyPair
  tryToUnlock: 0 | 1
  protobufEncoder: (name: string, data: Record<string, unknown>) => {message: Uint8Array}
  randomBytes: (n: number) => Uint8Array
}): {
  trezorMaskedStaticPubkey: Uint8Array
  trezorEncryptedStaticPubkey: Uint8Array
  hostEncryptedStaticPubkey: Uint8Array
  hostKey: Uint8Array
  trezorKey: Uint8Array
  handshakeHash: Uint8Array
  credentials: ThpCredentials | undefined
  allCredentials: ThpCredentials[]
  encryptedPayload: Uint8Array
  staticKey: Uint8Array
  hostStaticKeys: Curve25519KeyPair
} => {
  if (!thpState.handshakeCredentials) throw new Error('ThpStateMissing')

  const {trezorEphemeralPubkey, trezorEncryptedStaticPubkey, tag} = handshakeInitResponse
  const {sendNonce, recvNonce} = thpState
  const {handshakeHash} = thpState.handshakeCredentials
  const iv0 = getIvFromNonce(sendNonce)
  const iv1 = getIvFromNonce(recvNonce)

  let h: Uint8Array
  let point: Uint8Array

  // 1. h = SHA-256(protocol_name || device_properties) — already done in getHandshakeHash
  h = handshakeHash
  // 2. h = SHA-256(h || host_ephemeral_pubkey)
  h = hashOfTwo(h, hostEphemeralKeys.publicKey)
  // 3. h = SHA-256(h || try_to_unlock)
  h = hashOfTwo(h, new Uint8Array([tryToUnlock]))
  // 4. h = SHA-256(h || trezor_ephemeral_pubkey)
  h = hashOfTwo(h, trezorEphemeralPubkey)
  // 5. ck, k = HKDF(protocol_name, X25519(host_ephemeral_privkey, trezor_ephemeral_pubkey))
  point = curve25519(hostEphemeralKeys.privateKey, trezorEphemeralPubkey)
  let [ck, k] = hkdf(getProtocolName(), point)

  // 6. trezor_masked_static_pubkey = AES-GCM-DECRYPT(key=k, IV=0^96, ad=h, encrypted_trezor_static_pubkey)
  const trezorStaticPubkey = trezorEncryptedStaticPubkey.subarray(0, 32)
  const trezorStaticPubkeyTag = trezorEncryptedStaticPubkey.subarray(32, 32 + 16)
  const trezorMaskedStaticPubkey = aesGcmDecrypt(k, iv0, h, trezorStaticPubkey, trezorStaticPubkeyTag)
  // 7. h = SHA-256(h || encrypted_trezor_static_pubkey)
  h = hashOfTwo(h, trezorEncryptedStaticPubkey)
  // 8. ck, k = HKDF(ck, X25519(host_ephemeral_privkey, trezor_masked_static_pubkey))
  point = curve25519(hostEphemeralKeys.privateKey, trezorMaskedStaticPubkey)
  ;[ck, k] = hkdf(ck, point)

  // 9. Verify tag of empty string
  aesGcmDecrypt(k, iv0, h, new Uint8Array(0), tag)
  // 10. h = SHA-256(h || tag)
  h = hashOfTwo(h, tag)

  // 11. Search credentials for known pairing
  const allCredentials = findKnownPairingCredentials(knownCredentials, trezorMaskedStaticPubkey, trezorEphemeralPubkey)
  const credentials = allCredentials.length > 0 ? allCredentials[0] : undefined

  // Generate or restore host static key
  const staticKey = credentials?.host_static_key ? hexToBytes(credentials.host_static_key) : randomBytes(32)
  const hostStaticKeys = getCurve25519KeyPair(staticKey)

  // 12. encrypted_host_static_pubkey = AES-GCM-ENCRYPT(key=k, IV=0^95||1, ad=h, plaintext=host_static_pubkey)
  const {ciphertext: hostStaticCiphertext, tag: hostStaticTag} = aesGcmEncrypt(k, iv1, h, hostStaticKeys.publicKey)
  const hostEncryptedStaticPubkey = concatBytes(hostStaticCiphertext, hostStaticTag)
  // 13. h = SHA-256(h || encrypted_host_static_pubkey)
  h = hashOfTwo(h, hostEncryptedStaticPubkey)
  // 14. ck, k = HKDF(ck, X25519(host_static_privkey, trezor_ephemeral_pubkey))
  point = curve25519(hostStaticKeys.privateKey, trezorEphemeralPubkey)
  ;[ck, k] = hkdf(ck, point)

  // 15. payload_binary = PROTOBUF-ENCODE(ThpHandshakeCompletionReqNoisePayload)
  const {message} = protobufEncoder('ThpHandshakeCompletionReqNoisePayload', {
    host_pairing_credential: credentials?.credential,
  })
  // 16. encrypted_payload = AES-GCM-ENCRYPT(key=k, IV=0^96, ad=h, plaintext=payload_binary)
  const {ciphertext: payloadCiphertext, tag: payloadTag} = aesGcmEncrypt(k, iv0, h, message)
  const encryptedPayload = concatBytes(payloadCiphertext, payloadTag)
  h = hashOfTwo(h, encryptedPayload)

  // HH2/HH3: derive session keys
  const [hostKey, trezorKey] = hkdf(ck, new Uint8Array(0))

  return {
    trezorMaskedStaticPubkey,
    trezorEncryptedStaticPubkey,
    hostEncryptedStaticPubkey,
    hostKey,
    trezorKey,
    handshakeHash: h,
    credentials,
    allCredentials,
    encryptedPayload,
    staticKey,
    hostStaticKeys,
  }
}

// --- CPace key generation (for CodeEntry pairing) ---

export const getCpaceHostKeys = (
  code: Uint8Array,
  handshakeHash: Uint8Array,
  randomBytes: (n: number) => Uint8Array,
): {privateKey: Uint8Array; publicKey: Uint8Array} => {
  const prefix = new Uint8Array([0x08, 0x43, 0x50, 0x61, 0x63, 0x65, 0x32, 0x35, 0x35, 0x06])
  const padding = concatBytes(new Uint8Array([0x6f]), new Uint8Array(111), new Uint8Array([0x20]))

  const input = concatBytes(prefix, code, padding, handshakeHash, new Uint8Array([0x00]))
  const sha = sha512(input).subarray(0, 32)

  const generator = elligator2(sha)
  const privateKey = randomBytes(32)
  const publicKey = curve25519(privateKey, generator)

  return {privateKey: new Uint8Array(privateKey), publicKey}
}

export const getSharedSecret = (publicKey: Uint8Array, privateKey: Uint8Array): Uint8Array => {
  const sharedSecret = curve25519(privateKey, publicKey)
  return sha256(new Uint8Array(sharedSecret))
}

// --- Pairing tag validators ---

export const validateCodeEntryTag = (credentials: ThpHandshakeCredentials, value: string, secret: string): void => {
  // Assert handshake_commitment = SHA-256(secret)
  const sha = sha256(hexToBytes(secret))
  const {handshakeHash, handshakeCommitment, codeEntryChallenge} = credentials
  if (!bytesEqual(sha, handshakeCommitment)) {
    throw new Error(`HP5: commitment mismatch ${bytesToHex(handshakeCommitment)} != ${bytesToHex(sha)}`)
  }

  // Assert value = SHA-256(CodeEntry || h || secret || challenge) % 1000000
  const input = concatBytes(
    new Uint8Array([2]), // ThpPairingMethod.CodeEntry
    handshakeHash,
    hexToBytes(secret),
    codeEntryChallenge,
  )
  const calculatedValue = bigEndianBytesToBigInt(sha256(input)) % 1000000n
  if (calculatedValue !== BigInt(value)) {
    throw new Error(`HP5: code mismatch ${value} != ${calculatedValue.toString()}`)
  }
}

export const validateQrCodeTag = ({handshakeHash}: ThpHandshakeCredentials, value: string, secret: string): void => {
  const input = concatBytes(
    new Uint8Array([3]), // ThpPairingMethod.QrCode
    handshakeHash,
    hexToBytes(secret),
  )
  const calculatedValue = sha256(input).subarray(0, 16)
  const expectedValue = hexToBytes(value).subarray(0, 16)
  if (!bytesEqual(calculatedValue, expectedValue)) {
    throw new Error(`HP6: code mismatch ${bytesToHex(calculatedValue)} != ${bytesToHex(expectedValue)}`)
  }
}

export const validateNfcTag = ({handshakeHash}: ThpHandshakeCredentials, value: string, secret: Uint8Array): void => {
  const input = concatBytes(
    new Uint8Array([4]), // ThpPairingMethod.NFC
    handshakeHash,
    secret,
  )
  const calculatedValue = sha256(input).subarray(0, 16)
  const expectedValue = hexToBytes(value).subarray(0, 16)
  if (!bytesEqual(calculatedValue, expectedValue)) {
    throw new Error(`HP7: code mismatch ${bytesToHex(calculatedValue)} != ${bytesToHex(expectedValue)}`)
  }
}
