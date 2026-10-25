/**
 * CIP-5 bech32 encoding for the shared (multisig) key set.
 *
 * A co-signer key travels between wallets as text, and CIP-5 reserves distinct
 * prefixes for the shared key chain precisely so a reader can tell an ordinary
 * CIP-1852 key from a CIP-1854 one. Pasting an `acct_xvk` where an
 * `acct_shared_xvk` belongs builds a script over someone's everyday spending
 * key, which is exactly the confusion the prefixes exist to prevent — so the
 * prefix is *checked*, never inferred.
 *
 * @module
 */

import {bech32, hex} from '@pnyx/crypto'
import {Either} from 'effect'

/** bech32 caps encodings at 90 chars by default; an extended key needs ~110. */
const LIMIT = 1023

export const SHARED_PREFIX = {
  /** Account-level extended verification key — 32-byte pubkey ‖ 32-byte chain code. */
  accountXvk: 'acct_shared_xvk',
  /** Payment (role 0) verification key hash. */
  paymentVkh: 'addr_shared_vkh',
  /** Stake (role 2) verification key hash. */
  stakeVkh: 'stake_shared_vkh',
} as const

export type SharedPrefix = (typeof SHARED_PREFIX)[keyof typeof SHARED_PREFIX]

/** Byte length each prefix must carry. A wrong length is a wrong key, not a truncated one. */
const EXPECTED_BYTES: Record<SharedPrefix, number> = {
  [SHARED_PREFIX.accountXvk]: 64,
  [SHARED_PREFIX.paymentVkh]: 28,
  [SHARED_PREFIX.stakeVkh]: 28,
}

export type SharedKeyError =
  | {readonly kind: 'malformed'; readonly reason: string}
  | {readonly kind: 'wrong-prefix'; readonly expected: SharedPrefix; readonly actual: string}
  | {readonly kind: 'wrong-length'; readonly expected: number; readonly actual: number}

/** Encode hex-encoded key bytes under a CIP-5 shared prefix. */
export const encodeSharedKey = (prefix: SharedPrefix, keyHex: string): Either.Either<string, SharedKeyError> => {
  const bytes = hex.decode(keyHex)
  if (Either.isLeft(bytes)) return Either.left({kind: 'malformed', reason: 'not hex'})
  const expected = EXPECTED_BYTES[prefix]
  if (bytes.right.length !== expected) {
    return Either.left({kind: 'wrong-length', expected, actual: bytes.right.length})
  }
  return Either.right(bech32.encode(prefix, bech32.toWords(bytes.right), LIMIT))
}

/**
 * Decode a bech32 shared key to hex, requiring the given prefix.
 *
 * The prefix is an argument rather than a return value on purpose: every call
 * site knows which kind of key it wants, and accepting whatever arrives is how a
 * stake key ends up in a payment script.
 */
export const decodeSharedKey = (prefix: SharedPrefix, text: string): Either.Either<string, SharedKeyError> => {
  let decoded: {prefix: string; words: number[]}
  try {
    decoded = bech32.decode(text.trim() as `${string}1${string}`, LIMIT)
  } catch (e) {
    return Either.left({kind: 'malformed', reason: e instanceof Error ? e.message : String(e)})
  }
  if (decoded.prefix !== prefix) {
    return Either.left({kind: 'wrong-prefix', expected: prefix, actual: decoded.prefix})
  }
  const bytes = Uint8Array.from(bech32.fromWords(decoded.words))
  const expected = EXPECTED_BYTES[prefix]
  if (bytes.length !== expected) return Either.left({kind: 'wrong-length', expected, actual: bytes.length})
  return Either.right(hex.encode(bytes))
}

/** `acct_shared_xvk…` for a hex account xpub. */
export const encodeAccountXvk = (accountXpubHex: string): Either.Either<string, SharedKeyError> =>
  encodeSharedKey(SHARED_PREFIX.accountXvk, accountXpubHex)

/** Hex account xpub from `acct_shared_xvk…`. */
export const decodeAccountXvk = (text: string): Either.Either<string, SharedKeyError> =>
  decodeSharedKey(SHARED_PREFIX.accountXvk, text)

/** The bech32 prefix of a string, without validating the payload — for routing a scanned value. */
export const prefixOf = (text: string): string | null => {
  const trimmed = text.trim()
  const sep = trimmed.lastIndexOf('1')
  return sep <= 0 ? null : trimmed.slice(0, sep).toLowerCase()
}
