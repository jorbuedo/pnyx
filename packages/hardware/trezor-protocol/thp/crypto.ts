/**
 * THP cryptographic primitives.
 *
 * Uses @noble/* for cross-platform compatibility (React Native + Web).
 * Replaces Node.js crypto usage in trezor-suite.
 *
 * @module
 */

import {gcm} from '@noble/ciphers/aes.js'
import {hmac} from '@noble/hashes/hmac.js'
import {sha256 as nobleSha256, sha512 as nobleSha512} from '@noble/hashes/sha2.js'

import {concatBytes, writeInt32BE} from '../bytes'

// --- CRC-32 ---

const getCrcTable = () =>
  new Int32Array([
    0x00000000, 0x77073096, 0xee0e612c, 0x990951ba, 0x076dc419, 0x706af48f, 0xe963a535, 0x9e6495a3, 0x0edb8832,
    0x79dcb8a4, 0xe0d5e91e, 0x97d2d988, 0x09b64c2b, 0x7eb17cbd, 0xe7b82d07, 0x90bf1d91, 0x1db71064, 0x6ab020f2,
    0xf3b97148, 0x84be41de, 0x1adad47d, 0x6ddde4eb, 0xf4d4b551, 0x83d385c7, 0x136c9856, 0x646ba8c0, 0xfd62f97a,
    0x8a65c9ec, 0x14015c4f, 0x63066cd9, 0xfa0f3d63, 0x8d080df5, 0x3b6e20c8, 0x4c69105e, 0xd56041e4, 0xa2677172,
    0x3c03e4d1, 0x4b04d447, 0xd20d85fd, 0xa50ab56b, 0x35b5a8fa, 0x42b2986c, 0xdbbbc9d6, 0xacbcf940, 0x32d86ce3,
    0x45df5c75, 0xdcd60dcf, 0xabd13d59, 0x26d930ac, 0x51de003a, 0xc8d75180, 0xbfd06116, 0x21b4f4b5, 0x56b3c423,
    0xcfba9599, 0xb8bda50f, 0x2802b89e, 0x5f058808, 0xc60cd9b2, 0xb10be924, 0x2f6f7c87, 0x58684c11, 0xc1611dab,
    0xb6662d3d, 0x76dc4190, 0x01db7106, 0x98d220bc, 0xefd5102a, 0x71b18589, 0x06b6b51f, 0x9fbfe4a5, 0xe8b8d433,
    0x7807c9a2, 0x0f00f934, 0x9609a88e, 0xe10e9818, 0x7f6a0dbb, 0x086d3d2d, 0x91646c97, 0xe6635c01, 0x6b6b51f4,
    0x1c6c6162, 0x856530d8, 0xf262004e, 0x6c0695ed, 0x1b01a57b, 0x8208f4c1, 0xf50fc457, 0x65b0d9c6, 0x12b7e950,
    0x8bbeb8ea, 0xfcb9887c, 0x62dd1ddf, 0x15da2d49, 0x8cd37cf3, 0xfbd44c65, 0x4db26158, 0x3ab551ce, 0xa3bc0074,
    0xd4bb30e2, 0x4adfa541, 0x3dd895d7, 0xa4d1c46d, 0xd3d6f4fb, 0x4369e96a, 0x346ed9fc, 0xad678846, 0xda60b8d0,
    0x44042d73, 0x33031de5, 0xaa0a4c5f, 0xdd0d7cc9, 0x5005713c, 0x270241aa, 0xbe0b1010, 0xc90c2086, 0x5768b525,
    0x206f85b3, 0xb966d409, 0xce61e49f, 0x5edef90e, 0x29d9c998, 0xb0d09822, 0xc7d7a8b4, 0x59b33d17, 0x2eb40d81,
    0xb7bd5c3b, 0xc0ba6cad, 0xedb88320, 0x9abfb3b6, 0x03b6e20c, 0x74b1d29a, 0xead54739, 0x9dd277af, 0x04db2615,
    0x73dc1683, 0xe3630b12, 0x94643b84, 0x0d6d6a3e, 0x7a6a5aa8, 0xe40ecf0b, 0x9309ff9d, 0x0a00ae27, 0x7d079eb1,
    0xf00f9344, 0x8708a3d2, 0x1e01f268, 0x6906c2fe, 0xf762575d, 0x806567cb, 0x196c3671, 0x6e6b06e7, 0xfed41b76,
    0x89d32be0, 0x10da7a5a, 0x67dd4acc, 0xf9b9df6f, 0x8ebeeff9, 0x17b7be43, 0x60b08ed5, 0xd6d6a3e8, 0xa1d1937e,
    0x38d8c2c4, 0x4fdff252, 0xd1bb67f1, 0xa6bc5767, 0x3fb506dd, 0x48b2364b, 0xd80d2bda, 0xaf0a1b4c, 0x36034af6,
    0x41047a60, 0xdf60efc3, 0xa867df55, 0x316e8eef, 0x4669be79, 0xcb61b38c, 0xbc66831a, 0x256fd2a0, 0x5268e236,
    0xcc0c7795, 0xbb0b4703, 0x220216b9, 0x5505262f, 0xc5ba3bbe, 0xb2bd0b28, 0x2bb45a92, 0x5cb36a04, 0xc2d7ffa7,
    0xb5d0cf31, 0x2cd99e8b, 0x5bdeae1d, 0x9b64c2b0, 0xec63f226, 0x756aa39c, 0x026d930a, 0x9c0906a9, 0xeb0e363f,
    0x72076785, 0x05005713, 0x95bf4a82, 0xe2b87a14, 0x7bb12bae, 0x0cb61b38, 0x92d28e9b, 0xe5d5be0d, 0x7cdcefb7,
    0x0bdbdf21, 0x86d3d2d4, 0xf1d4e242, 0x68ddb3f8, 0x1fda836e, 0x81be16cd, 0xf6b9265b, 0x6fb077e1, 0x18b74777,
    0x88085ae6, 0xff0f6a70, 0x66063bca, 0x11010b5c, 0x8f659eff, 0xf862ae69, 0x616bffd3, 0x166ccf45, 0xa00ae278,
    0xd70dd2ee, 0x4e048354, 0x3903b3c2, 0xa7672661, 0xd06016f7, 0x4969474d, 0x3e6e77db, 0xaed16a4a, 0xd9d65adc,
    0x40df0b66, 0x37d83bf0, 0xa9bcae53, 0xdebb9ec5, 0x47b2cf7f, 0x30b5ffe9, 0xbdbdf21c, 0xcabac28a, 0x53b39330,
    0x24b4a3a6, 0xbad03605, 0xcdd70693, 0x54de5729, 0x23d967bf, 0xb3667a2e, 0xc4614ab8, 0x5d681b02, 0x2a6f2b94,
    0xb40bbe37, 0xc30c8ea1, 0x5a05df1b, 0x2d02ef8d,
  ])

export const crc32 = (buf: Uint8Array): Uint8Array => {
  const table = getCrcTable()
  let crc = -1
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i] ?? 0
    crc = (table[(crc ^ b) & 0xff] ?? 0) ^ (crc >>> 8)
  }
  const result = new Uint8Array(4)
  writeInt32BE(result, crc ^ -1, 0)
  return result
}

// --- AES-256-GCM ---

export const aesGcmEncrypt = (
  key: Uint8Array,
  iv: Uint8Array,
  aad: Uint8Array,
  plaintext: Uint8Array,
): {ciphertext: Uint8Array; tag: Uint8Array} => {
  const cipher = gcm(key, iv, aad)
  const encrypted = cipher.encrypt(plaintext)
  // @noble/ciphers appends the 16-byte tag to the ciphertext
  const ciphertext = encrypted.subarray(0, encrypted.length - 16)
  const tag = encrypted.subarray(encrypted.length - 16)
  return {ciphertext, tag}
}

export const aesGcmDecrypt = (
  key: Uint8Array,
  iv: Uint8Array,
  aad: Uint8Array,
  ciphertext: Uint8Array,
  tag: Uint8Array,
): Uint8Array => {
  const cipher = gcm(key, iv, aad)
  // @noble/ciphers expects ciphertext + tag concatenated
  const combined = new Uint8Array(ciphertext.length + tag.length)
  combined.set(ciphertext)
  combined.set(tag, ciphertext.length)
  return cipher.decrypt(combined)
}

// --- SHA-256, HMAC-SHA256 ---

export const sha256 = (data: Uint8Array): Uint8Array => nobleSha256(data)

export const hmacSha256 = (key: Uint8Array, data: Uint8Array): Uint8Array => hmac(nobleSha256, key, data)

export const hashOfTwo = (hash1: Uint8Array, hash2: Uint8Array): Uint8Array => {
  return sha256(concatBytes(hash1, hash2))
}

// --- HKDF (Noise-style two-output) ---

export const hkdf = (chainingKey: Uint8Array, input: Uint8Array): [Uint8Array, Uint8Array] => {
  const tempKey = hmacSha256(chainingKey, input)
  const output1 = hmacSha256(tempKey, new Uint8Array([0x01]))
  const ctx2Input = new Uint8Array(output1.length + 1)
  ctx2Input.set(output1)
  ctx2Input[output1.length] = 0x02
  const output2 = hmacSha256(tempKey, ctx2Input)
  return [output1, output2]
}

// --- IV from nonce ---

export const getIvFromNonce = (nonce: number): Uint8Array => {
  const iv = new Uint8Array(12)
  // Write nonce as big-endian uint64 at bytes [4..12]
  let n = nonce
  for (let i = 0; i < 8; i++) {
    iv[11 - i] = n & 0xff
    n = n >> 8
  }
  return iv
}

// --- BigInt helpers ---

export const bigEndianBytesToBigInt = (bytes: Uint8Array): bigint => {
  let result = 0n
  for (const b of bytes) {
    result = (result << 8n) + BigInt(b)
  }
  return result
}

export const littleEndianBytesToBigInt = (bytes: Uint8Array): bigint => {
  let result = 0n
  for (let i = 0; i < bytes.length; i++) {
    result += BigInt(bytes[i] ?? 0) << (8n * BigInt(i))
  }
  return result
}

// --- X25519 / Curve25519 ---

function bigintToLittleEndianBytes(value: bigint, length = 32): Uint8Array {
  const byteArray = new Uint8Array(length)
  let v = value
  for (let i = 0; i < length; i++) {
    byteArray[i] = Number(v & 0xffn)
    v >>= 8n
  }
  return byteArray
}

function pow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n
  let b = base % mod
  let e = exp
  while (e > 0) {
    if (e % 2n === 1n) {
      result = (result * b) % mod
    }
    e = e >> 1n
    b = (b * b) % mod
  }
  return result
}

const p = 2n ** 255n - 19n
const J = 486662n
const c3 = BigInt('19681161376707505956807079304988542015446066515923890162744021073123829784752') // sqrt(-1)
const c4 = (p - 5n) / 8n
const a24 = (J + 2n) / 4n

function decodeScalar(scalar: Uint8Array): bigint {
  const array = new Uint8Array(scalar)
  array[0] = (array[0] ?? 0) & 248
  array[31] = (array[31] ?? 0) & 127
  array[31] = (array[31] ?? 0) | 64
  return littleEndianBytesToBigInt(array)
}

function decodeCoordinate(coordinate: Uint8Array): bigint {
  const array = new Uint8Array(coordinate)
  const last = array.length - 1
  array[last] = (array[last] ?? 0) & 0x7f
  return littleEndianBytesToBigInt(array)
}

function encodeCoordinate(coordinate: bigint): Uint8Array {
  return bigintToLittleEndianBytes(coordinate)
}

function conditionalSwap(a: bigint, b: bigint, condition: boolean): [bigint, bigint] {
  return condition ? [b, a] : [a, b]
}

function conditionalMove(first: bigint, second: bigint, condition: boolean): bigint {
  return condition ? second : first
}

function ladderOperation(x1: bigint, x2: bigint, z2: bigint, x3: bigint, z3: bigint): [bigint, bigint, bigint, bigint] {
  const a = (x2 + z2) % p
  const aa = (a * a) % p
  const b = (x2 - z2 + p) % p
  const bb = (b * b) % p
  const e = (aa - bb + p) % p
  const c = (x3 + z3) % p
  const d = (x3 - z3 + p) % p
  const da = (d * a) % p
  const cb = (c * b) % p
  const t0 = (da + cb) % p
  const x5 = (t0 * t0) % p
  const t1 = (da - cb + p) % p
  const t2 = (t1 * t1) % p
  const z5 = (x1 * t2) % p
  const x4 = (aa * bb) % p
  const t3 = (a24 * e) % p
  const t4 = (bb + t3) % p
  const z4 = (e * t4) % p
  return [x4, z4, x5, z5]
}

export function curve25519(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  const k = decodeScalar(privateKey)
  const u = decodeCoordinate(publicKey) % p
  const x1 = u
  let x2 = 1n
  let z2 = 0n
  let x3 = u
  let z3 = 1n
  let swap = 0

  for (let i = 255; i >= 0; i--) {
    const bit = Number((k >> BigInt(i)) & 1n)
    swap ^= bit
    ;[x2, x3] = conditionalSwap(x2, x3, Boolean(swap))
    ;[z2, z3] = conditionalSwap(z2, z3, Boolean(swap))
    swap = bit
    ;[x2, z2, x3, z3] = ladderOperation(x1, x2, z2, x3, z3)
  }

  ;[x2, x3] = conditionalSwap(x2, x3, Boolean(swap))
  ;[z2, z3] = conditionalSwap(z2, z3, Boolean(swap))

  const x = (pow(z2, p - 2n, p) * x2) % p
  return encodeCoordinate(x)
}

export function elligator2(point: Uint8Array): Uint8Array {
  const u = decodeCoordinate(point) % p

  let tv1 = (u * u) % p
  tv1 = (2n * tv1) % p
  const xd = (tv1 + 1n) % p
  const x1n = (-J + p) % p
  let tv2 = (xd * xd) % p
  const gxd = (tv2 * xd) % p
  let gx1 = (J * tv1) % p
  gx1 = (gx1 * x1n) % p
  gx1 = (gx1 + tv2) % p
  gx1 = (gx1 * x1n) % p

  let tv3 = (gxd * gxd) % p
  tv2 = (tv3 * tv3) % p
  tv3 = (tv3 * gxd) % p
  tv3 = (tv3 * gx1) % p
  tv2 = (tv2 * tv3) % p

  let y11 = pow(tv2, c4, p)
  y11 = (y11 * tv3) % p
  const y12 = (y11 * c3) % p
  tv2 = (y11 * y11) % p
  tv2 = (tv2 * gxd) % p

  const e1 = tv2 === gx1
  const y1 = conditionalMove(y12, y11, e1)
  const x2n = (x1n * tv1) % p

  tv2 = (y1 * y1) % p
  tv2 = (tv2 * gxd) % p
  const e3 = tv2 === gx1
  const xn = conditionalMove(x2n, x1n, e3)
  const x = (xn * pow(xd, p - 2n, p)) % p

  return encodeCoordinate(x)
}

export const getCurve25519KeyPair = (randomBytes: Uint8Array): {publicKey: Uint8Array; privateKey: Uint8Array} => {
  const randomPriv = new Uint8Array(randomBytes)
  randomPriv[0] = (randomPriv[0] ?? 0) & 248
  randomPriv[31] = (randomPriv[31] ?? 0) & 127
  randomPriv[31] = (randomPriv[31] ?? 0) | 64

  const basepoint = new Uint8Array(32)
  basepoint[0] = 0x09

  return {
    publicKey: curve25519(randomPriv, basepoint),
    privateKey: randomPriv,
  }
}

// --- SHA-512 (for CPace) ---

export const sha512 = (data: Uint8Array): Uint8Array => nobleSha512(data)
