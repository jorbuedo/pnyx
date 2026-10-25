import {describe, expect, it} from 'vitest'

import {midnightReadRefusal} from './midnight-read-refusal'

/** The exact rejection the native reader produced for an on-chain preprod transaction, 2026-08-29. */
const boundTransaction = new Error(
  "Call to function 'MidnightNative.walletReadOp' has been rejected.\n" +
    '→ Caused by: java.lang.RuntimeException: not a proven, signature-enabled, pre-binding transaction ' +
    '(Transaction<SignatureEnabled, Proof, PreBinding>): expected header tag ' +
    "'midnight:transaction[v9](signature[v1],proof,embedded-fr[v1]):', got " +
    "'midnight:transaction[v9](signature[v1],proof,pedersen-schnorr[",
)

describe('midnightReadRefusal', () => {
  // Since 2026-08-29 the native reader handles both binding states, so this refusal means the device's
  // native library is behind the JS — a build problem, not a payload problem.
  it('reports a bound refusal as a stale native rail, not a bad payload', () => {
    const refusal = midnightReadRefusal(boundTransaction)
    expect(refusal).toContain('native library is older')
    expect(refusal).toContain('The bytes are fine')
    // The original message actively misled: the bytes ARE a Midnight transaction.
    expect(refusal).not.toContain('not a Midnight transaction')
  })

  it('reports an unrecognised header shape with the reader’s own first line', () => {
    const refusal = midnightReadRefusal(new Error("expected header tag 'a', got 'b'\nstack line"))
    expect(refusal).toContain("expected header tag 'a', got 'b'")
    expect(refusal).not.toContain('stack line')
  })

  it('falls back to the generic refusal for bytes that are not a transaction at all', () => {
    expect(midnightReadRefusal(new Error('failed to deserialize'))).toBe(
      'those bytes are not a Midnight transaction this wallet can read',
    )
  })

  it('handles a non-Error rejection', () => {
    expect(midnightReadRefusal('boom')).toBe('those bytes are not a Midnight transaction this wallet can read')
  })
})
