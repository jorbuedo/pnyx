import {describe, expect, it} from 'vitest'
import {
  checkSignedUploadEnvelope,
  SIGNED_UPLOAD_CLOCK_SKEW_MS,
  type SignedUploadFields,
  signedUploadFieldsAreWellFormed,
  signedUploadPayload,
} from './signed-upload.js'

const digest = 'a'.repeat(64)
const fields = (over: Partial<SignedUploadFields> = {}): SignedUploadFields => ({
  domain: 'pnyx-bug-report',
  timestampMs: 1_757_000_000_000,
  nonce: 'nonce_0123456789abcdef',
  bodySha256Hex: digest,
  ...over,
})

describe('signedUploadPayload', () => {
  it('puts the version first, so a layout change is a rejection and not a mis-parse', () => {
    expect(signedUploadPayload(fields())).toBe(`pnyx-bug-report.v1.1757000000000.nonce_0123456789abcdef.${digest}`)
  })

  // ⚠️ The reason the nonce charset excludes '.'. If a field could contain the separator,
  // two different field sets would canonicalise to one string — a signature that
  // authenticates a request the signer never made.
  it('cannot be made ambiguous by the fields it accepts', () => {
    const a = signedUploadPayload(fields({nonce: 'aaaaaaaaaaaaaaaa'}))
    const b = signedUploadPayload(fields({nonce: 'bbbbbbbbbbbbbbbb'}))
    expect(a).not.toBe(b)
    expect(signedUploadFieldsAreWellFormed(fields({nonce: `x.${'y'.repeat(20)}`}))).toBe(false)
  })

  it('changes when any signed field changes', () => {
    const base = signedUploadPayload(fields())
    expect(signedUploadPayload(fields({timestampMs: 1_757_000_000_001}))).not.toBe(base)
    expect(signedUploadPayload(fields({bodySha256Hex: 'b'.repeat(64)}))).not.toBe(base)
  })

  // ⚠️ The domain is what stops a Koios or SteelSwap signature — same identity key, empty
  // external_aad — from authenticating an upload here. Two endpoints must never be able to
  // canonicalise to one string.
  it('separates two domains that agree on every other field', () => {
    expect(signedUploadPayload(fields({domain: 'pnyx-bug-report'}))).not.toBe(
      signedUploadPayload(fields({domain: 'pnyx-something-else'})),
    )
  })

  it('refuses a domain that could forge a field boundary', () => {
    expect(signedUploadFieldsAreWellFormed(fields({domain: 'a.v1.1.x'}))).toBe(true)
    expect(signedUploadFieldsAreWellFormed(fields({domain: ''}))).toBe(false)
    expect(signedUploadFieldsAreWellFormed(fields({domain: 'Has-Upper'}))).toBe(false)
    expect(signedUploadFieldsAreWellFormed(fields({domain: 'has space'}))).toBe(false)
  })
})

describe('signedUploadFieldsAreWellFormed', () => {
  it('accepts a well-formed envelope', () => {
    expect(signedUploadFieldsAreWellFormed(fields())).toBe(true)
  })

  it('requires a lowercase 64-char hex digest', () => {
    expect(signedUploadFieldsAreWellFormed(fields({bodySha256Hex: 'A'.repeat(64)}))).toBe(false)
    expect(signedUploadFieldsAreWellFormed(fields({bodySha256Hex: 'a'.repeat(63)}))).toBe(false)
    expect(signedUploadFieldsAreWellFormed(fields({bodySha256Hex: 'g'.repeat(64)}))).toBe(false)
  })

  it('requires a nonce long enough not to collide by accident', () => {
    expect(signedUploadFieldsAreWellFormed(fields({nonce: 'short'}))).toBe(false)
    expect(signedUploadFieldsAreWellFormed(fields({nonce: 'z'.repeat(129)}))).toBe(false)
  })

  it('rejects a non-integer or non-positive timestamp', () => {
    expect(signedUploadFieldsAreWellFormed(fields({timestampMs: 0}))).toBe(false)
    expect(signedUploadFieldsAreWellFormed(fields({timestampMs: -1}))).toBe(false)
    expect(signedUploadFieldsAreWellFormed(fields({timestampMs: 1.5}))).toBe(false)
    expect(signedUploadFieldsAreWellFormed(fields({timestampMs: Number.NaN}))).toBe(false)
  })
})

describe('checkSignedUploadEnvelope', () => {
  const now = 1_757_000_000_000

  it('passes a request whose digest matches and whose clock agrees', () => {
    expect(checkSignedUploadEnvelope({fields: fields(), receivedBodySha256Hex: digest, serverNowMs: now})).toBeNull()
  })

  // ⚠️ Both directions. A window that only looks backwards refuses every request from a
  // device whose clock runs fast — and the report that would have told us is the one being
  // refused.
  it('allows skew in both directions and refuses beyond it', () => {
    const ahead = fields({timestampMs: now + SIGNED_UPLOAD_CLOCK_SKEW_MS - 1})
    const behind = fields({timestampMs: now - SIGNED_UPLOAD_CLOCK_SKEW_MS + 1})
    expect(checkSignedUploadEnvelope({fields: ahead, receivedBodySha256Hex: digest, serverNowMs: now})).toBeNull()
    expect(checkSignedUploadEnvelope({fields: behind, receivedBodySha256Hex: digest, serverNowMs: now})).toBeNull()

    const tooFarAhead = fields({timestampMs: now + SIGNED_UPLOAD_CLOCK_SKEW_MS + 1})
    const tooFarBehind = fields({timestampMs: now - SIGNED_UPLOAD_CLOCK_SKEW_MS - 1})
    expect(checkSignedUploadEnvelope({fields: tooFarAhead, receivedBodySha256Hex: digest, serverNowMs: now})).toBe(
      'clock-skew',
    )
    expect(checkSignedUploadEnvelope({fields: tooFarBehind, receivedBodySha256Hex: digest, serverNowMs: now})).toBe(
      'clock-skew',
    )
  })

  // The digest is what binds the body to the signature. Without this check the signature
  // would attest a digest nobody compared against the bytes that arrived.
  it('refuses a body that is not the one signed', () => {
    expect(checkSignedUploadEnvelope({fields: fields(), receivedBodySha256Hex: 'b'.repeat(64), serverNowMs: now})).toBe(
      'body-digest-mismatch',
    )
  })

  it('reports a malformed envelope before anything else', () => {
    // Ordering matters: a malformed nonce with a stale timestamp is malformed, and reporting
    // skew for it would send someone looking at the wrong thing.
    expect(
      checkSignedUploadEnvelope({
        fields: fields({nonce: 'bad', timestampMs: 1}),
        receivedBodySha256Hex: digest,
        serverNowMs: now,
      }),
    ).toBe('malformed')
  })

  it('rejects a server-side digest that is not a digest', () => {
    expect(checkSignedUploadEnvelope({fields: fields(), receivedBodySha256Hex: 'nope', serverNowMs: now})).toBe(
      'malformed',
    )
  })
})
