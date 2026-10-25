/**
 * The canonical string a CIP-8 signature covers when a client uploads a body.
 *
 * ⚠️ **One implementation, imported by both sides.** The signer is the app and the verifier
 * is a Cloudflare Worker; if each built this string for itself, a change to one would show
 * up as "signature invalid" with nothing to point at. A test that runs a hand-copy of a
 * canonicaliser is not a test of the protocol — it is two protocols that happen to agree
 * today. So this lives in a package both can depend on.
 *
 * ## What is signed, and why not the body
 *
 * The signature covers `v1.<timestampMs>.<nonce>.<sha256(body) hex>` — the digest, not the
 * bytes. A multi-megabyte body would otherwise have to be materialised and passed through
 * the signer twice, on a phone, on the JS thread. The digest binds the body just as tightly:
 * the verifier hashes what it received and refuses if it differs, so a substituted body
 * fails even though it was never signed directly.
 *
 * The timestamp and nonce are inside the signed string, not merely alongside it. A replay
 * defence the attacker can rewrite is not one — moving either field outside the signature
 * would let a captured request be re-dated and replayed for ever.
 *
 * ## ⚠️ The verifier MUST compare this string to the signed payload
 *
 * This string is the COSE payload, and checking it is **not** something the COSE layer does
 * for you. `Cose.verifyDataForAddress` proves two things — the signature is valid over
 * whatever payload the message carries, and the verification key owns the address — and
 * nothing at all about *what* was signed. A verifier that stops there accepts any signature
 * that address ever produced, including the Koios and SteelSwap challenges the same identity
 * key signs. So a verifier has two jobs, and skipping the second is a silent auth bypass.
 *
 * `external_aad` would bind it cryptographically and leave nothing to forget, and that was the
 * first design here. It is unreachable: the COSE tier exports only `verifyDataForAddress`,
 * which takes no `externalAad`, and keeps its `Sign1` parser private. So the payload is
 * compared directly — see `services/content/src/cose-payload.ts`, which extracts it with the
 * CBOR primitives that are exported.
 *
 * The {@link SignedUploadFields.domain} is what makes that comparison sufficient: a signature
 * over a Koios challenge cannot equal a string beginning with this endpoint's domain, and a
 * future endpoint reusing this module gets its own.
 *
 * @module
 */

/** Protocol tag. Present so a future change to the layout is a rejection, never a mis-parse. */
export const SIGNED_UPLOAD_VERSION = 'v1'

/** Charset for a domain tag: separator-free, so it cannot forge the field boundaries. */
const DOMAIN_PATTERN = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/

/**
 * How far apart the client's and the server's clocks may be.
 *
 * ⚠️ **Both directions.** A phone can be behind *or* ahead, and a window that only looks
 * backwards rejects every request from a fast clock — which reads to the user as "bug
 * reports don't work" and is invisible to us, because the report that would have told us is
 * the one being refused. Five minutes is wide enough for an unsynchronised device and narrow
 * enough that a captured request is stale before it can be reused at scale; the nonce, not
 * this window, is what makes a single replay impossible.
 */
export const SIGNED_UPLOAD_CLOCK_SKEW_MS = 5 * 60_000

export type SignedUploadFields = {
  /**
   * What this signature is *for* — e.g. `pnyx-bug-report`.
   *
   * ⚠️ **Load-bearing, not decoration.** The same identity key signs Koios and SteelSwap
   * challenges, and `verifyDataForAddress` checks the signature and the address binding but
   * never compares the signed payload. Without a domain inside the signed bytes, a signature
   * captured from any of those flows would authenticate an upload here.
   */
  readonly domain: string
  /** Client wall-clock in epoch milliseconds. */
  readonly timestampMs: number
  /** Single-use, client-generated. The server stores it for the skew window. */
  readonly nonce: string
  /** Lowercase hex SHA-256 of the exact body bytes. */
  readonly bodySha256Hex: string
}

/**
 * The exact string both sides sign and verify.
 *
 * Fields are joined with `.` and none of them may contain one: a separator that can appear
 * inside a field makes two different field sets produce one string, which is a signature
 * that authenticates the wrong request. {@link signedUploadFieldsAreWellFormed} is what
 * enforces that, and callers must run it first.
 */
export const signedUploadPayload = (fields: SignedUploadFields): string =>
  `${fields.domain}.${SIGNED_UPLOAD_VERSION}.${fields.timestampMs}.${fields.nonce}.${fields.bodySha256Hex}`

/** Nonce charset: URL-safe, separator-free, and long enough not to collide by accident. */
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/

/**
 * Whether these fields can be safely canonicalised.
 *
 * Rejects rather than sanitises. A nonce with a `.` in it is not a nonce to be cleaned up —
 * it is a caller doing something this protocol does not describe, and quietly stripping the
 * character would make the signed string differ from the one the sender believed it signed.
 */
export const signedUploadFieldsAreWellFormed = (fields: SignedUploadFields): boolean =>
  DOMAIN_PATTERN.test(fields.domain) &&
  Number.isSafeInteger(fields.timestampMs) &&
  fields.timestampMs > 0 &&
  NONCE_PATTERN.test(fields.nonce) &&
  SHA256_HEX_PATTERN.test(fields.bodySha256Hex)

/** Why a signed upload's envelope was refused, before any signature maths runs. */
export type SignedUploadEnvelopeRejection = 'malformed' | 'clock-skew' | 'body-digest-mismatch'

/**
 * Check the parts of a signed upload that need no key material.
 *
 * Separate from signature verification, and run first, because these are the cheap
 * rejections: an ed25519 verify on a request whose digest already disagrees is wasted work
 * on an isolate someone else is paying for. Returns the reason rather than a boolean so the
 * caller can log which rule bit — "malformed", "your clock is off" and "your body changed
 * in flight" are three different problems and one of them is ours.
 */
export const checkSignedUploadEnvelope = (params: {
  readonly fields: SignedUploadFields
  /** Digest the server computed over the bytes it actually received. */
  readonly receivedBodySha256Hex: string
  readonly serverNowMs: number
  readonly skewMs?: number
}): SignedUploadEnvelopeRejection | null => {
  if (!signedUploadFieldsAreWellFormed(params.fields)) return 'malformed'
  if (!SHA256_HEX_PATTERN.test(params.receivedBodySha256Hex)) return 'malformed'
  const skew = params.skewMs ?? SIGNED_UPLOAD_CLOCK_SKEW_MS
  if (Math.abs(params.serverNowMs - params.fields.timestampMs) > skew) return 'clock-skew'
  if (params.fields.bodySha256Hex !== params.receivedBodySha256Hex) return 'body-digest-mismatch'
  return null
}
