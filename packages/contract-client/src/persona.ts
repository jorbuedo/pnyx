// Seed → per-circle persona derivation (spec §4.3 — the anonymous-identity HKDF tree).
//
//   forumRoot    = HKDF-SHA256(ikm = wallet seed, info = "pnyx:root")
//   persona sk_C = HKDF-SHA256(ikm = forumRoot,   info = "pnyx:persona:" ‖ circleId)
//
// `circleId` is the circle contract's 32-byte constructor argument (`@pnyx/contract-client/circle-id`).
// It used to arrive as a `bigint` because the spike numbered circles with a contract-global counter;
// the bytes fed to HKDF are unchanged, so personas derived under a numeric id still derive
// identically from that id's 32-byte little-endian form.
//
// The network used to be part of the persona info, on the argument that byte-identical persona
// commitments across preprod and mainnet would let an observer link a test persona to a real one.
// That rested on preprod being throwaway, and it is not: the launch path runs real users on preprod
// until mainnet opens. It also bought nothing it was not already getting — `circleId` is the other
// HKDF input, circles are not carried across the migration, and a redeployed circle has a different
// `circleId`, so personas diverge on that input alone. What the network *did* cost was a second
// scalar in a derivation that must stay frozen for life. See identity.ts for the same reasoning
// applied to `C`: who you are is not where you are.
//
// Deterministic, so a persona (and everything it derives — member leaf, nullifiers) is recoverable
// from the wallet seed alone. This is the on-device replacement for the interim server-side
// `deriveSk(PERSONA_SECRET, subject, circleId)`: the `personaSk` witness now derives entirely on the
// device from the seed and never leaves it. `forumRoot` is the only thing that must be backed up
// for anonymous-identity recovery (research docs 05/09).
import {ed25519} from '@noble/curves/ed25519.js'
import {hkdf} from '@noble/hashes/hkdf.js'
import {sha256} from '@noble/hashes/sha2.js'

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)

// Field element → its 32-byte little-endian representation (= compact's `convertFieldToBytes(32, x)`
// for the circleId range). Implemented locally so this module stays free of
// `@midnight-ntwrk/compact-runtime`, which drags in the onchain-runtime WASM that cannot bundle/run
// on React Native (Hermes) — the whole reason on-device proving is native.
const fieldToBytes32 = (x: bigint): Uint8Array => {
  const out = new Uint8Array(32)
  let v = x
  for (let i = 0; i < 32; i++) {
    out[i] = Number(v & 0xffn)
    v >>= 8n
  }
  return out
}

/** `forumRoot = HKDF-SHA256(seed, "pnyx:root")` — the seed-derived anonymous-identity master. */
export const forumRoot = (seed: Uint8Array): Uint8Array => hkdf(sha256, seed, undefined, utf8('pnyx:root'), 32)

/**
 * Per-circle persona secret from an already-derived `forumRoot`:
 * `sk_C = HKDF-SHA256(forumRoot, "pnyx:persona:" ‖ circleId)` (`circleId` as its 32 bytes, matching
 * the on-chain encoding). Split from [`derivePersonaSk`] so a session can cache `forumRoot` once
 * (seed available only at sign-in) and derive per-circle personas without re-touching the enclave.
 * This is the `personaSk` witness the forum circuits consume.
 *
 * The label is a fixed prefix followed by exactly 32 bytes, so no separator is needed and no two
 * circleIds can encode identically.
 */
export const personaSkFromForumRoot = (root: Uint8Array, circleId: Uint8Array): Uint8Array => {
  if (circleId.length !== 32)
    throw new Error(`personaSkFromForumRoot: circleId must be 32 bytes, got ${circleId.length}`)
  const label = utf8('pnyx:persona:')
  const info = new Uint8Array(label.length + 32)
  info.set(label)
  info.set(circleId, label.length)
  return hkdf(sha256, root, undefined, info, 32)
}

/**
 * Per-circle persona secret straight from the wallet seed (= `personaSkFromForumRoot(forumRoot(seed), …)`),
 * taking the id as a field element rather than bytes.
 *
 * Kept on the numeric form because that is what pins the derivation's golden vectors: a `bigint`'s
 * 32-byte little-endian encoding is exactly what the spike's `circleId` fed to HKDF, so those vectors
 * still hold across the move to a `Bytes<32>` id.
 */
export const derivePersonaSk = (seed: Uint8Array, circleId: bigint): Uint8Array =>
  personaSkFromForumRoot(forumRoot(seed), fieldToBytes32(circleId))

/**
 * The per-circle key a moderator signs content-plane requests with. The public half is what the
 * circle's `moderatorAuth` map stores against this persona's leaf.
 *
 * Keyed on `personaSk`, not on `forumRoot` and `circleId` separately: the leaf the key is stored
 * against *is* `personaCommitment(personaSk)`, so deriving from the same secret makes "the key in
 * this row" and "the key this persona holds" the same fact rather than two that must be kept in step.
 *
 * Ed25519, mirroring {@link module:./identity}'s `authKeyPair` — 32-byte public key, which is exactly
 * what the contract's `Bytes<32>` value holds. The contract never checks the signature (Compact 0.23
 * has no in-circuit signature verification); the service does, and what makes that trustworthy is
 * that only a proven moderator could have written the row.
 */
export const moderatorAuthKeyPair = (personaSk: Uint8Array): {secretKey: Uint8Array; publicKey: Uint8Array} => {
  if (personaSk.length !== 32)
    throw new Error(`moderatorAuthKeyPair: personaSk must be 32 bytes, got ${personaSk.length}`)
  const secretKey = hkdf(sha256, personaSk, undefined, utf8('pnyx:modauth'), 32)
  return {secretKey, publicKey: ed25519.getPublicKey(secretKey)}
}
