import {describe, expect, it} from 'vitest'
import {assetFingerprint} from './asset-fingerprint'

// CIP-14's own test vectors.
const POLICY_A = '7eae28af2208be856f7a119668ae52a49b73725e326dc16579dcc373'

describe('assetFingerprint', () => {
  it('matches the CIP-14 vector for an empty asset name', () => {
    expect(assetFingerprint(`${POLICY_A}.`)).toBe('asset1rjklcrnsdzqp65wjgrg55sy9723kw09mlgvlc3')
  })

  it('matches the CIP-14 vector for a named asset', () => {
    expect(assetFingerprint(`${POLICY_A}.504154415445`)).toBe('asset13n25uv0yaf5kus35fm2k86cqy60z58d9xmde92')
  })

  it('fingerprints a CIP-68 asset over its full name, prefix included', () => {
    // The fingerprint identifies the asset as the ledger sees it, so the CIP-67
    // label is part of the input — stripping it would name a different asset.
    const withPrefix = assetFingerprint(`${POLICY_A}.0014df10434c4950204954`)
    const withoutPrefix = assetFingerprint(`${POLICY_A}.434c4950204954`)
    expect(withPrefix).toMatch(/^asset1[0-9a-z]+$/)
    expect(withPrefix).not.toBe(withoutPrefix)
  })

  it('returns null for ADA and for a malformed id rather than a broken link', () => {
    expect(assetFingerprint('')).toBeNull()
    expect(assetFingerprint('.')).toBeNull()
    expect(assetFingerprint('deadbeef.00')).toBeNull()
    expect(assetFingerprint(`${POLICY_A}.zzzz`)).toBeNull()
  })
})
