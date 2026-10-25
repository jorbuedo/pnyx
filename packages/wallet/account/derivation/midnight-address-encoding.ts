/**
 * Pure Midnight bech32m address encoding.
 *
 * A faithful port of the encode paths in `@midnight-ntwrk/wallet-sdk-address-format`, minus that
 * package's top-level `import { EncryptionSecretKey } from '@midnight-ntwrk/ledger-v8'`. That import
 * exists only for a secret-key *decode* path we never use, but being a top-level ES import it eagerly
 * loads the ledger WASM the moment the address package is imported. Encoding itself is pure —
 * bech32m (`@scure/base`) + SCALE-compact (`@subsquid/scale-codec`) — so we do it here with no WASM.
 *
 * HRP is `mn_<type>[_<network>]`; mainnet has no network segment (`mn_dust1…`), any other id is
 * embedded as a segment (`mn_dust_<id>1…`).
 *
 * @module
 */

import {sha256} from '@noble/hashes/sha2.js'
import {getLogger} from '@pnyx/logger'
import {bech32m} from '@scure/base'
import {ByteSink} from '@subsquid/scale-codec'

const logger = getLogger('wallet')

/** `'mainnet'` produces addresses with no network segment; any other id is embedded as one. */
export type MidnightNetworkId = 'mainnet' | (string & {})

/** BLS12-381 scalar field (Fr) modulus. The DUST public key is a scalar in this field. */
export const BLS_SCALAR_MODULUS = 0x73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001n

const HRP_PREFIX = 'mn'

/** Midnight addresses exceed bech32's 90-char limit, so encoding passes `false` to disable it. */
const encodeBech32m = (type: string, networkId: MidnightNetworkId, payload: Uint8Array): string => {
  const networkSegment = networkId === 'mainnet' ? '' : `_${networkId}`
  return bech32m.encode(`${HRP_PREFIX}_${type}${networkSegment}`, bech32m.toWords(payload), false)
}

/** Encode an unshielded (night) address (`mn_addr…`) — a 32-byte payload, identity-encoded. */
export const encodeNightAddress = (addressBytes: Uint8Array, networkId: MidnightNetworkId): string => {
  if (addressBytes.length !== 32) {
    throw new Error(`Unshielded address must be 32 bytes, got ${addressBytes.length}`)
  }
  return encodeBech32m('addr', networkId, addressBytes)
}

/**
 * The 32-byte unshielded address payload for a BIP-340 x-only verifying key, in pure JS.
 *
 * Production never derives it this way — {@link deriveMidnightNightAddress} asks the curve backend
 * for `nightPayload`, which is ledger WASM on Node/Web and a native module on React Native. This is
 * the independent statement of the same rule, kept so those two backends can be pinned against it:
 * `midnight-address-encoding.test.ts` checks it against ledger-v8's own `addressFromKey`, and
 * `midnight.test.ts` checks the derived address matches the one the wallet displays. If Midnight
 * ever changes how an address is formed, that pair fails instead of the wallet quietly showing an
 * address nobody can pay.
 *
 * Rejects anything that is not exactly 32 bytes: sha256 of a 33-byte SEC1 key is still 32 bytes, so
 * a lenient check would hand back a plausible-looking address for a malformed key. The ledger
 * `.d.ts` "35-byte versioned UserAddress" claim is stale — no shipped version does that.
 */
export const nightPayloadFromVerifyingKey = (verifyingKey: Uint8Array): Uint8Array => {
  if (verifyingKey.length !== 32) {
    throw new Error(`Verifying key must be 32 bytes (x-only BIP-340), got ${verifyingKey.length}`)
  }
  return sha256(verifyingKey)
}

/** Encode a DUST address (`mn_dust…`) — SCALE-compact of the BLS12-381 scalar public key. */
export const encodeDustAddress = (publicKey: bigint, networkId: MidnightNetworkId): string => {
  if (publicKey < 0n || publicKey >= BLS_SCALAR_MODULUS) {
    throw new Error('DUST public key is out of the BLS12-381 scalar field range')
  }
  const sink = new ByteSink()
  sink.compact(publicKey)
  return encodeBech32m('dust', networkId, Uint8Array.from(sink.toBytes()))
}

/**
 * Recover the raw DUST payload bytes from an `mn_dust…` address — the inverse of {@link encodeDustAddress}'s
 * bech32m step. These bytes (the SCALE-compact scalar, ≤ 33 bytes) are exactly the `dust_address` value a
 * cNIGHT→DUST registration datum carries, so this is how the tx-builder turns a wallet's `mn_dust` address
 * into the datum payload. Does not decode the SCALE-compact back to the scalar — the registration only ever
 * needs the on-chain payload bytes verbatim.
 */
export const decodeDustAddressPayload = (address: string): Uint8Array => {
  if (!address.startsWith(`${HRP_PREFIX}_dust`)) {
    throw new Error(`Not an mn_dust address: ${address.slice(0, 12)}…`)
  }
  // `limit: false` mirrors the encode side — Midnight addresses exceed bech32's 90-char cap.
  const {words} = bech32m.decode(address as `${string}1${string}`, false)
  return bech32m.fromWords(words)
}

/**
 * Re-encode raw DUST payload bytes as an `mn_dust…` address — the exact inverse of
 * {@link decodeDustAddressPayload}, and the bytes-level counterpart to {@link encodeDustAddress}
 * (which starts from the scalar).
 *
 * This is what turns a registration datum's `dust_address` back into something a user can read.
 * Without it, a registration pointing at an address the wallet does not itself own could only be
 * described as "somewhere else" — even though the datum names the destination exactly, and
 * delegating DUST to another party is a supported, deliberate choice rather than an anomaly.
 */
export const encodeDustAddressPayload = (payload: Uint8Array, networkId: MidnightNetworkId): string => {
  if (payload.length === 0 || payload.length > 33) {
    throw new Error(`DUST payload must be 1..33 bytes, got ${payload.length}`)
  }
  return encodeBech32m('dust', networkId, payload)
}

/** Encode a shielded Zswap address (`mn_shield-addr…`) — coinPublicKey(32) ‖ encryptionPublicKey(32). */
export const encodeShieldedAddress = (
  coinPublicKey: Uint8Array,
  encryptionPublicKey: Uint8Array,
  networkId: MidnightNetworkId,
): string => {
  if (coinPublicKey.length !== 32) {
    throw new Error(`Shielded coin public key must be 32 bytes, got ${coinPublicKey.length}`)
  }
  if (encryptionPublicKey.length !== 32) {
    throw new Error(`Shielded encryption public key must be 32 bytes, got ${encryptionPublicKey.length}`)
  }
  const payload = new Uint8Array(64)
  payload.set(coinPublicKey, 0)
  payload.set(encryptionPublicKey, 32)
  return encodeBech32m('shield-addr', networkId, payload)
}

/**
 * Encode a shielded **coin** public key on its own (`mn_shield-cpk…`).
 *
 * The dApp connector reports the two halves of a shielded address separately as well as the address
 * itself, which is the only reason these exist apart from {@link encodeShieldedAddress}.
 */
export const encodeShieldedCoinPublicKey = (coinPublicKey: Uint8Array, networkId: MidnightNetworkId): string => {
  if (coinPublicKey.length !== 32) {
    throw new Error(`Shielded coin public key must be 32 bytes, got ${coinPublicKey.length}`)
  }
  return encodeBech32m('shield-cpk', networkId, coinPublicKey)
}

/** Encode a shielded **encryption** public key on its own (`mn_shield-epk…`). */
export const encodeShieldedEncryptionPublicKey = (
  encryptionPublicKey: Uint8Array,
  networkId: MidnightNetworkId,
): string => {
  if (encryptionPublicKey.length !== 32) {
    throw new Error(`Shielded encryption public key must be 32 bytes, got ${encryptionPublicKey.length}`)
  }
  return encodeBech32m('shield-epk', networkId, encryptionPublicKey)
}

/** Which of Midnight's three address kinds a string is. */
export type MidnightAddressKind = 'night' | 'dust' | 'shielded'

/**
 * The read of a Midnight address, or the reason it is not one.
 *
 * Three outcomes rather than a boolean, because a send screen has three different things to say. A
 * Cardano address is *not* an error here; a mistyped `mn_addr…` is, and telling the two apart is the
 * whole point — bech32m's checksum makes "you dropped a character" a fact rather than a guess.
 */
export type MidnightAddressParse =
  | {
      readonly ok: true
      readonly kind: MidnightAddressKind
      readonly network: MidnightNetworkId
      readonly payload: Uint8Array
    }
  /** No `mn_` prefix at all. Some other chain's address, a name, or nothing yet typed. */
  | {readonly ok: false; readonly reason: 'not-midnight'}
  /** `mn_` but a type this version does not know — a newer address form, not a typo. */
  | {readonly ok: false; readonly reason: 'unknown-type'; readonly hrp: string}
  /** The right shape and the wrong bytes: bad checksum, or a payload the kind cannot have. */
  | {readonly ok: false; readonly reason: 'malformed'}

/** Payload sizes each kind must have. Anything else is a malformed address, not a new kind. */
const PAYLOAD_BOUNDS: Readonly<Record<MidnightAddressKind, {readonly min: number; readonly max: number}>> = {
  night: {min: 32, max: 32},
  shielded: {min: 64, max: 64},
  // SCALE-compact of a BLS scalar, so a range rather than a fixed width.
  dust: {min: 1, max: 33},
}

/** Longest first: `addr` is not a prefix of `shield-addr`, but relying on that is a trap for the next type. */
const HRP_TYPES: readonly (readonly [string, MidnightAddressKind])[] = [
  ['shield-addr', 'shielded'],
  ['addr', 'night'],
  ['dust', 'dust'],
]

/**
 * Read a Midnight address's kind, network and payload from the address itself.
 *
 * The network comes out as `'mainnet'` when the HRP carries no segment, mirroring
 * {@link encodeNightAddress} — so `parse(encode(x))` round-trips, which is what
 * `midnight-address-encoding.test.ts` asserts.
 *
 * Upper-case input is normalised: bech32 is case-insensitive but forbids *mixed* case, and a QR scan
 * legitimately produces the upper-case form (it packs denser in a QR's alphanumeric mode).
 */
export const parseMidnightAddress = (address: string): MidnightAddressParse => {
  const trimmed = address.trim()
  const normalised = trimmed === trimmed.toUpperCase() ? trimmed.toLowerCase() : trimmed
  if (!normalised.startsWith(`${HRP_PREFIX}_`)) return {ok: false, reason: 'not-midnight'}

  let decoded: {prefix: string; words: number[]}
  try {
    decoded = bech32m.decode(normalised as `${string}1${string}`, false)
  } catch (e: unknown) {
    // The prefix says Midnight, so this is a damaged Midnight address rather than something else.
    logger.debug('Midnight address failed bech32m decode', {
      origin: 'midnight-address-encoding',
      error: String(e),
    })
    return {ok: false, reason: 'malformed'}
  }

  const hrp = decoded.prefix
  const rest = hrp.slice(HRP_PREFIX.length + 1)
  const match = HRP_TYPES.find(([type]) => rest === type || rest.startsWith(`${type}_`))
  if (match === undefined) return {ok: false, reason: 'unknown-type', hrp}
  const [type, kind] = match
  const network = rest === type ? 'mainnet' : rest.slice(type.length + 1)
  if (network === '') return {ok: false, reason: 'unknown-type', hrp}

  let payload: Uint8Array
  try {
    payload = bech32m.fromWords(decoded.words)
  } catch (e: unknown) {
    logger.debug('Midnight address words could not be converted to bytes', {
      origin: 'midnight-address-encoding',
      error: String(e),
    })
    return {ok: false, reason: 'malformed'}
  }
  const bounds = PAYLOAD_BOUNDS[kind]
  if (payload.length < bounds.min || payload.length > bounds.max) return {ok: false, reason: 'malformed'}
  return {ok: true, kind, network, payload}
}
