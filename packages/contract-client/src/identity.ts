// The Pnyx account identity — `C` — and its wire encoding (docs/PNYX_IDENTITY_PLAN.md).
//
//   identitySk = HKDF-SHA256(ikm = forumRoot, info = "pnyx:id")
//   C          = persistentHash(["pnyx:id", identitySk])           // derivations.ts
//
// `C` is what a peer needs and all they need: the contract keys its row by this value and
// authenticates writes by proving knowledge of `identitySk`, so there is no signature to check and
// nothing a reader must verify. It replaces `mn_addr` as the Pnyx identity.
//
// Derived from `forumRoot` rather than the seed directly, so `forumRoot` remains the single value
// that must be backed up to recover everything (same argument as persona.ts).
//
// **One identity across every network, and one for life.** `C` used to take the network as an HKDF
// domain separator so a preprod identity could not be linked to a mainnet one. That argument was
// borrowed from personas, where it holds because a persona is anonymous by design — but `C` is a
// *public* identifier, handed to peers and rendered as an avatar the user picked at onboarding.
// Unlinkability of something deliberately public buys nothing, and anyone wanting a separate
// identity uses a separate seed, which is one action and total. What it cost was real: the launch
// path is preprod-with-real-users → mainnet, and a network-scoped `C` made that migration a reset
// of every identity, avatar and DM anchor. Cross-network replay is prevented in the signed
// challenge (see {@link authChallengeMessage}), never in the derivation.
//
// **No version suffix.** An unversioned info string *is* the first version, and a suffixed one can
// be appended later without the unsuffixed form ever having claimed to be "v1". Carrying a version
// implied an upgrade path that does not exist: bumping it changes `identitySk`, so every user
// becomes a different person — new `C`, new avatar, new auth key, new DM anchor. The lever that
// actually resets a *namespace* is the deploy nonce, which changes contract addresses while leaving
// `C` untouched. Frozen at the preprod launch, when real users arrive.
//
// No `@midnight-ntwrk/compact-runtime` import here: this module must run on Hermes, and that
// package drags in the onchain-runtime WASM. That is why {@link identityCommitmentOf} recomputes
// the commitment with plain SHA-256 instead of reusing `derivations.ts` — `identity.test.ts` pins
// the two equal, so the Hermes-safe path cannot drift from the circuit mirror.
import {ed25519} from '@noble/curves/ed25519.js'
import {hkdf} from '@noble/hashes/hkdf.js'
import {sha256} from '@noble/hashes/sha2.js'
import {bech32m} from '@scure/base'

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)

const hex = (bytes: Uint8Array): string => {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

/** The only HRP an id ever carries. Not network-scoped — see the module note. */
const HRP_PREFIX = 'pnyx_id'

/**
 * The account identity secret. Never leaves the device: only `C` and the proof do.
 *
 * @param forumRoot the seed-derived master from {@link module:./persona}
 */
export const identitySkFromForumRoot = (forumRoot: Uint8Array): Uint8Array =>
  hkdf(sha256, forumRoot, undefined, utf8('pnyx:id'), 32)

/**
 * `C = persistentHash(["pnyx:id", identitySk])`, computed without `compact-runtime`.
 *
 * Compact's `persistentHash` over a `Vector<2, Bytes<32>>` is SHA-256 of the two 32-byte chunks
 * concatenated, so this is the same value `derivations.ts` produces — asserted by a test, because
 * a silent divergence would key rows the circuit can never write.
 */
export const identityCommitmentOf = (identitySk: Uint8Array): Uint8Array => {
  if (identitySk.length !== 32) {
    throw new Error(`identityCommitment: secret must be 32 bytes, got ${identitySk.length}`)
  }
  const tag = new Uint8Array(32)
  tag.set(new TextEncoder().encode('pnyx:id'))
  const input = new Uint8Array(64)
  input.set(tag)
  input.set(identitySk, 32)
  return sha256(input)
}

/**
 * The session-login keypair, derived from the same secret and published as `authPub` in the row.
 *
 * Ed25519 rather than BIP-340 because **only our service verifies it** — never a circuit — so
 * there is no reason to inherit Midnight's curve here. What makes it trustworthy is not the
 * scheme but where the public half lives: only `identitySk`'s holder can write row `C`, so a
 * signature checking out against that row's `authPub` proves the same knowledge a proof would.
 */
export const authKeyPair = (identitySk: Uint8Array): {secretKey: Uint8Array; publicKey: Uint8Array} => {
  const secretKey = hkdf(sha256, identitySk, undefined, utf8('pnyx:auth'), 32)
  return {secretKey, publicKey: ed25519.getPublicKey(secretKey)}
}

/**
 * The bytes a login challenge signs.
 *
 * Domain and network are inside the signature so a challenge answered for one deployment cannot
 * be replayed against another; the nonce is what stops replay within one.
 */
export const authChallengeMessage = (domain: string, network: string, pnyxId: string, nonce: string): Uint8Array =>
  utf8(`pnyx:auth|${domain}|${network}|${pnyxId}|${nonce}`)

/**
 * The bytes a push-token binding signs, proving the identity that claims an FCM token is the one
 * that owns it.
 *
 * The session JWT already proves *someone* logged in as this identity, but a bearer token is
 * replayable for its lifetime: whoever holds one could bind their own device's token to the
 * victim's identity and start receiving their notifications — who is messaging them, which circles
 * are active. Signing with the identity's own key closes that, because the key never leaves the
 * device while the JWT travels on every request.
 *
 * `pnyx:fcm` rather than `pnyx:auth` is load-bearing: a distinct tag means a binding
 * signature can never be replayed as a login (or the reverse), even though both are Ed25519 over
 * the same key. The token and platform are inside the signature so it authorises **this** binding
 * rather than "some binding" — otherwise a captured signature could be paired with a different
 * token. The nonce is what stops replay of the whole thing.
 *
 * The token enters as a **fixed-length SHA-256 hex digest**, not verbatim. With a `|`-delimited
 * message and two variable-length tail fields, `(token "a|android", platform "x")` and
 * `(token "a", platform "android|x")` would produce identical bytes — one signature authorising two
 * different bindings. A 64-char digest makes the split unambiguous no matter how loosely the token
 * and platform are validated later.
 */
export const deviceBindingMessage = (
  domain: string,
  network: string,
  pnyxId: string,
  nonce: string,
  fcmToken: string,
  platform: string,
): Uint8Array => utf8(`pnyx:fcm|${domain}|${network}|${pnyxId}|${nonce}|${hex(sha256(utf8(fcmToken)))}|${platform}`)

/** Encode `C` for sharing. The inverse of {@link decodePnyxId}. */
export const encodePnyxId = (identity: Uint8Array): string => {
  if (identity.length !== 32) {
    throw new Error(`pnyx_id: identity must be 32 bytes, got ${identity.length}`)
  }
  return bech32m.encode(HRP_PREFIX, bech32m.toWords(identity), false)
}

export type DecodedPnyxId = {
  readonly identity: Uint8Array
}

/**
 * Decode a shared identity. Throws on a bad checksum, a foreign HRP or a wrong-length payload —
 * a malformed id must not be silently treated as "not found", which reads to a user as a typo on
 * the *other* person's part.
 *
 * An id names a person, not a chain, so there is no network to return and a `pnyx_id` shared from
 * any deployment decodes here. Whether that person has published a row on *this* network is a
 * lookup, and its absence is an honest "not registered here yet" rather than a decode failure.
 */
export const decodePnyxId = (value: string): DecodedPnyxId => {
  const {prefix, words} = bech32m.decode(value as `${string}1${string}`, false)
  if (prefix !== HRP_PREFIX) {
    throw new Error(`pnyx_id: unexpected HRP '${prefix}'`)
  }
  const identity = bech32m.fromWords(words)
  if (identity.length !== 32) {
    throw new Error(`pnyx_id: payload must be 32 bytes, got ${identity.length}`)
  }
  return {identity: Uint8Array.from(identity)}
}

/**
 * Compare two identities by decoded bytes — never by string equality, because bech32m is
 * case-insensitive and the uppercase form of an id is the same identity.
 */
export const pnyxIdEquals = (a: string, b: string): boolean => {
  const da = decodePnyxId(a).identity
  const db = decodePnyxId(b).identity
  return da.every((x, i) => x === db[i])
}

/** A published identity row, mirroring the `IdentityRow` struct in pnyx.compact. */
export type IdentityRow = {
  /** MLS Ed25519 signature public key — what a DM resolves to. */
  readonly anchor: Uint8Array
  /** Session-login key; the service checks a challenge signature against this. */
  readonly authPub: Uint8Array
  /**
   * An optional handle, UTF-8 and zero-padded; all-zero means none.
   *
   * Plaintext rather than a hash, because the row is the *reverse* direction — rendering a handle
   * from a `C` requires bytes you can display, and a hash does not invert. Validity is defined by
   * `handle.ts`, which the contract cannot enforce: read it through `decodeHandle` rather than
   * rendering these bytes directly.
   */
  readonly name: Uint8Array
}
