/**
 * Detect an Ed25519 signature whose nonce was derived from public data — which
 * means the signature **leaks its own signing key**.
 *
 * Ed25519's nonce must come from the secret. Several shipped Cardano signers
 * derived it from the message instead, and a nonce anyone can recompute turns one
 * signature into the private scalar:
 *
 * ```
 *   r = <candidate derivation, from public data only>
 *   leaked  ⟺  R == r·B          (R = first 32 bytes of the signature)
 * ```
 *
 * 119 keys on mainnet are catalogued as compromised this way, across four
 * confirmed derivations plus a nonce-reuse case. Payment *and* stake keys leak;
 * the root/mnemonic never signs, so what leaks is the per-address scalar.
 *
 * **Detection only.** The recovery step is deliberately absent: this module says
 * "that key is burned", never "here is the key".
 *
 * Two properties to keep straight, because they are asymmetric:
 * - A single signature *proves* a leak.
 * - No single signature proves a key is safe. At least one catalogued signer
 *   leaked only sporadically — clean most of the time, bad on the occasional
 *   transaction — so a clean result is "no leak found here", never "safe".
 *
 * @module
 */

import {blake2b as blake2bRaw} from '@noble/hashes/blake2.js'
import {sha256, sha512} from '@noble/hashes/sha2.js'
import {keccak_256, sha3_256, sha3_512} from '@noble/hashes/sha3.js'
import {ed25519} from './curves.js'

const L = ed25519.Point.Fn.ORDER

/** Little-endian scalar, reduced — the byte order Ed25519 uses. */
const scalarLE = (b: Uint8Array): bigint => {
  let x = 0n
  for (let i = b.length - 1; i >= 0; i--) x = (x << 8n) | BigInt(b[i] as number)
  return x % L
}

const cat = (...parts: readonly Uint8Array[]): Uint8Array => {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/** `r·B` compressed, for comparing against a signature's R. */
const basepointMul = (r: bigint): Uint8Array => ed25519.Point.BASE.multiply(r === 0n ? L : r).toBytes()

const ZERO1 = new Uint8Array(1)
const ZERO32 = new Uint8Array(32)
const ZERO64 = new Uint8Array(64)
const UNDEF = new TextEncoder().encode('undefined')
const NULLS = new TextEncoder().encode('null')
const blake2b256 = (b: Uint8Array): Uint8Array => blake2bRaw(b, {dkLen: 32})

/**
 * Candidate nonces derived from the message alone. Computed once per message and
 * reused across every witness of a transaction, since M is shared.
 *
 * The `"undefined"` / `"null"` entries are not hypothetical: they are what a
 * JavaScript signer produces when the secret is missing and gets string-coerced
 * into the nonce input.
 */
const messageNonces = (m: Uint8Array): readonly (readonly [string, bigint])[] => [
  ['H(M)', scalarLE(sha512(m))],
  ['H(zero32|M)', scalarLE(sha512(cat(ZERO32, m)))],
  ['H(zero64|M)', scalarLE(sha512(cat(ZERO64, m)))],
  ['H(zero1|M)', scalarLE(sha512(cat(ZERO1, m)))],
  ['H("undefined"|M)', scalarLE(sha512(cat(UNDEF, m)))],
  ['H("null"|M)', scalarLE(sha512(cat(NULLS, m)))],
  ['reduce(M)', scalarLE(m)],
  ['H256(M)', scalarLE(sha256(m))],
  ['Blake2b256(M)', scalarLE(blake2b256(m))],
  ['Keccak256(M)', scalarLE(keccak_256(m))],
  ['SHA3-256(M)', scalarLE(sha3_256(m))],
  ['SHA3-512(M)', scalarLE(sha3_512(m))],
]

/** Candidates that fold the public key in — per witness, since A varies. */
const keyNonces = (m: Uint8Array, a: Uint8Array): readonly (readonly [string, bigint])[] => [
  ['H(A|M)', scalarLE(sha512(cat(a, m)))],
  ['H(M|A)', scalarLE(sha512(cat(m, a)))],
]

export type WeakNonceMatch = {
  /** Which public derivation reproduced this signature's R, e.g. `H(M)`. */
  readonly derivation: string
}

/**
 * The derivation that reproduces this signature's `R`, or `null` when none does.
 *
 * @param message The signed message — for a Cardano transaction, the tx body hash.
 * @param publicKey The 32-byte Ed25519 public key from the witness.
 * @param signature The 64-byte signature (`R ‖ S`).
 */
export const detectWeakEd25519Nonce = (
  message: Uint8Array,
  publicKey: Uint8Array,
  signature: Uint8Array,
): WeakNonceMatch | null => {
  if (signature.length !== 64 || publicKey.length !== 32) return null
  const r = signature.subarray(0, 32)
  const equals = (candidate: bigint): boolean => {
    try {
      const produced = basepointMul(candidate)
      if (produced.length !== r.length) return false
      let same = true
      for (let i = 0; i < r.length; i++) if (produced[i] !== r[i]) same = false
      return same
    } catch {
      return false
    }
  }
  for (const [derivation, candidate] of [...messageNonces(message), ...keyNonces(message, publicKey)]) {
    if (equals(candidate)) return {derivation}
  }
  return null
}

/**
 * Whether any witness in a set leaks its key. `true` is proof; `false` is only
 * "no leak found" — see the module note on asymmetry.
 */
export const anyWitnessLeaksKey = (
  message: Uint8Array,
  witnesses: readonly {readonly publicKey: Uint8Array; readonly signature: Uint8Array}[],
): boolean => witnesses.some((w) => detectWeakEd25519Nonce(message, w.publicKey, w.signature) !== null)
