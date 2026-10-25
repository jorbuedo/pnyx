import {describe, expect, it} from 'vitest'
import {decodeDustRegistrationDatum, encodeDustRegistrationDatum} from './registration-datum'

// Golden values decoded from a real cNIGHT→DUST register transaction — the only reason
// this encoder can be trusted, since the written proposal describes a different datum
// (a payment PubKeyHash plus an `active` flag) than the one that actually shipped.
const STAKE = '3a57af7913f0578ceddb35cd72e9abc3644189afb6607ce6d22d076e' // 28 bytes
const DUST = '736eac3e7bd29f5f6f950d57d3218f1f3194ba91e2e5f9e27b5add9f75fc78613d' // 33 bytes
const GOLDEN_DATUM = `d8799fd8799f581c${STAKE}ff5821${DUST}ff`

describe('encodeDustRegistrationDatum', () => {
  it('matches the datum CBOR from the decoded register tx, byte for byte', () => {
    expect(encodeDustRegistrationDatum(STAKE, DUST)).toBe(GOLDEN_DATUM)
  })

  it('normalises hex case, so the same registration never encodes two ways', () => {
    expect(encodeDustRegistrationDatum(STAKE.toUpperCase(), DUST.toUpperCase())).toBe(GOLDEN_DATUM)
  })

  it('switches byte-string header form below 24 bytes', () => {
    // < 24 bytes uses the inline `0x40|len` header, not the `0x58 len` form.
    const short = `73${'ab'.repeat(20)}` // 21 bytes
    expect(encodeDustRegistrationDatum(STAKE, short)).toBe(`d8799fd8799f581c${STAKE}ff55${short}ff`)
  })

  it('refuses a wrong-length stake key hash rather than padding it', () => {
    expect(() => encodeDustRegistrationDatum('abcd', DUST)).toThrow()
    expect(() => encodeDustRegistrationDatum(`${STAKE}ab`, DUST)).toThrow()
  })

  it('refuses an empty or oversized dust payload', () => {
    // The validator checks `length_of_bytearray(dust_address) <= 33`; truncating to fit
    // would designate a destination the user never chose.
    expect(() => encodeDustRegistrationDatum(STAKE, '')).toThrow()
    expect(() => encodeDustRegistrationDatum(STAKE, 'ab'.repeat(34))).toThrow()
  })

  it('refuses malformed hex', () => {
    expect(() => encodeDustRegistrationDatum('zz'.repeat(28), DUST)).toThrow()
  })
})

describe('decodeDustRegistrationDatum', () => {
  it('decodes the golden datum into its two fields', () => {
    expect(decodeDustRegistrationDatum(GOLDEN_DATUM)).toEqual({stakeKeyHash: STAKE, dustPayload: DUST})
  })

  it('round-trips with the encoder', () => {
    expect(decodeDustRegistrationDatum(encodeDustRegistrationDatum(STAKE, DUST))).toEqual({
      stakeKeyHash: STAKE,
      dustPayload: DUST,
    })
  })

  it('returns null for a datum of the wrong shape rather than a partial read', () => {
    // A half-decoded datum would let the wallet claim a DUST destination the chain does
    // not agree with, which is exactly the failure this whole module exists to avoid.
    expect(decodeDustRegistrationDatum('')).toBeNull()
    expect(decodeDustRegistrationDatum('not hex')).toBeNull()
    // One Constr0 instead of two nested.
    expect(decodeDustRegistrationDatum(`d8799f581c${STAKE}ff`)).toBeNull()
    // Trailing bytes past the outer break.
    expect(decodeDustRegistrationDatum(`${GOLDEN_DATUM}00`)).toBeNull()
    // Inner field the wrong length.
    expect(decodeDustRegistrationDatum(`d8799fd8799f581b${STAKE.slice(2)}ff5821${DUST}ff`)).toBeNull()
  })
})
