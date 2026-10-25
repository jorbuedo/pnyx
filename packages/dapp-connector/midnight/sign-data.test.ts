import {describe, expect, it} from 'vitest'
import {
  MIDNIGHT_SIGNATURE_SCHEME,
  MIDNIGHT_SIGNED_MESSAGE_PREFIX,
  readSignDataRequest,
  signatureResult,
  signedMessageBytes,
} from './sign-data.js'

const signedBytes = (result: ReturnType<typeof readSignDataRequest>): Uint8Array => {
  if (!result.ok) throw new Error(`expected a request, got a refusal: ${result.error.message}`)
  return result.request.message
}

const COLON = 0x3a

/**
 * The decoded payload, taken back out of the envelope the wallet actually signs.
 *
 * Every decoding assertion below goes through here, so each one also proves the envelope is present
 * and that its declared length describes the payload.
 */
const bytes = (result: ReturnType<typeof readSignDataRequest>): Uint8Array => {
  const signed = signedBytes(result)
  const tagEnd = signed.indexOf(COLON)
  const lengthEnd = signed.indexOf(COLON, tagEnd + 1)
  const decoder = new TextDecoder()
  expect(decoder.decode(signed.subarray(0, tagEnd))).toBe(MIDNIGHT_SIGNED_MESSAGE_PREFIX)
  const payload = signed.subarray(lengthEnd + 1)
  expect(Number(decoder.decode(signed.subarray(tagEnd + 1, lengthEnd)))).toBe(payload.length)
  return payload
}

const refused = (result: ReturnType<typeof readSignDataRequest>): boolean => !result.ok

describe('readSignDataRequest — text', () => {
  it('encodes to UTF-8, not UTF-16', () => {
    // The conversion the API asks for. "é" is one UTF-16 unit but two UTF-8 bytes; signing the UTF-16
    // form would produce a signature a dApp verifying UTF-8 could never check.
    expect([...bytes(readSignDataRequest(['é', {encoding: 'text'}]))]).toEqual([0xc3, 0xa9])
  })

  it('handles an astral character as four bytes', () => {
    expect(bytes(readSignDataRequest(['💡', {encoding: 'text'}]))).toHaveLength(4)
  })

  it('signs an empty string as no bytes rather than refusing', () => {
    expect(bytes(readSignDataRequest(['', {encoding: 'text'}]))).toHaveLength(0)
  })
})

describe('readSignDataRequest — hex', () => {
  it('decodes hex to the bytes it names', () => {
    expect([...bytes(readSignDataRequest(['00ff10', {encoding: 'hex'}]))]).toEqual([0, 255, 16])
  })

  it('accepts either case', () => {
    expect([...bytes(readSignDataRequest(['AbCd', {encoding: 'hex'}]))]).toEqual([0xab, 0xcd])
  })

  it('refuses an odd length or a non-hex character instead of signing something else', () => {
    // Falling back to text here would sign bytes the dApp never asked for — and the signature would
    // verify, over the wrong data, which is worse than an error.
    expect(refused(readSignDataRequest(['abc', {encoding: 'hex'}]))).toBe(true)
    expect(refused(readSignDataRequest(['zz', {encoding: 'hex'}]))).toBe(true)
  })
})

describe('readSignDataRequest — base64', () => {
  it('decodes base64 to bytes', () => {
    expect([...bytes(readSignDataRequest(['AAEC', {encoding: 'base64'}]))]).toEqual([0, 1, 2])
  })

  it('accepts padding', () => {
    expect([...bytes(readSignDataRequest(['AAE=', {encoding: 'base64'}]))]).toEqual([0, 1])
  })

  it('refuses a string outside the base64 alphabet', () => {
    expect(refused(readSignDataRequest(['!!!!', {encoding: 'base64'}]))).toBe(true)
    expect(refused(readSignDataRequest(['AAA', {encoding: 'base64'}]))).toBe(true)
  })
})

describe('readSignDataRequest — refusals', () => {
  it('refuses a missing or unknown encoding rather than guessing one', () => {
    expect(refused(readSignDataRequest(['abcd', {}]))).toBe(true)
    expect(refused(readSignDataRequest(['abcd', {encoding: 'utf8'}]))).toBe(true)
    expect(refused(readSignDataRequest(['abcd']))).toBe(true)
  })

  it('refuses a non-string payload', () => {
    expect(refused(readSignDataRequest([123, {encoding: 'text'}]))).toBe(true)
    expect(refused(readSignDataRequest([]))).toBe(true)
  })

  it('refuses a keyType the API does not define', () => {
    // A shielded key cannot sign this; answering with the unshielded one would silently substitute a
    // different key than the dApp named.
    expect(refused(readSignDataRequest(['ab', {encoding: 'hex', keyType: 'shielded'}]))).toBe(true)
  })

  it('accepts the one keyType the API defines, and an absent one', () => {
    expect(refused(readSignDataRequest(['ab', {encoding: 'hex', keyType: 'unshielded'}]))).toBe(false)
    expect(refused(readSignDataRequest(['ab', {encoding: 'hex'}]))).toBe(false)
  })
})

describe('signatureResult', () => {
  it('always states the scheme rather than relying on the API default', () => {
    const result = signatureResult({data: 'ab', signatureHex: '11'.repeat(64), verifyingKeyHex: '22'.repeat(32)})

    // The API defaults an absent `scheme` to schnorr_bip340 — relying on that is the "a field whose
    // absence means something" bug, and its own comment says the field becomes mandatory later.
    expect(result.scheme).toBe(MIDNIGHT_SIGNATURE_SCHEME)
  })

  it('echoes the payload exactly as the dApp sent it', () => {
    expect(signatureResult({data: 'Hello', signatureHex: 'aa', verifyingKeyHex: 'bb'}).data).toBe('Hello')
  })
})

describe('signedMessageBytes — domain separation', () => {
  it('wraps the payload in the tag and its byte length', () => {
    const signed = signedMessageBytes(new Uint8Array([1, 2, 3]))

    expect(new TextDecoder().decode(signed)).toBe(`${MIDNIGHT_SIGNED_MESSAGE_PREFIX}:3:\u0001\u0002\u0003`)
  })

  it('counts bytes, not characters', () => {
    // "é" is two UTF-8 bytes, so a length taken from the string would be off by one and every verifier
    // rebuilding the envelope would disagree with us.
    const signed = signedMessageBytes(new TextEncoder().encode('é'))

    expect(new TextDecoder().decode(signed).startsWith(`${MIDNIGHT_SIGNED_MESSAGE_PREFIX}:2:`)).toBe(true)
  })

  it('cannot be made to sign a transaction payload bare', () => {
    // The bytes the ledger signs to authorise an unshielded spend are
    // `b"midnight:hash-intent:" ‖ segment_id ‖ intent` (midnight-ledger, Intent::data_to_sign), signed
    // with the very same `SigningKey::sign` this method reaches. A dApp that hands those bytes over as
    // hex must not get a usable spend authorisation back — the envelope is what makes that impossible.
    const intentPayload = new TextEncoder().encode('midnight:hash-intent:\u0000\u0000forged intent')
    const asHex = [...intentPayload].map((b) => b.toString(16).padStart(2, '0')).join('')
    const signed = signedBytes(readSignDataRequest([asHex, {encoding: 'hex'}]))

    expect(signed).not.toEqual(intentPayload)
    expect(new TextDecoder().decode(signed).startsWith('midnight:hash-intent:')).toBe(false)
    expect(new TextDecoder().decode(signed).startsWith(`${MIDNIGHT_SIGNED_MESSAGE_PREFIX}:`)).toBe(true)
  })

  it('applies the envelope for every encoding, not only the one a test happened to cover', () => {
    for (const [data, encoding] of [
      ['plain text', 'text'],
      ['00ff', 'hex'],
      ['AAEC', 'base64'],
    ] as const) {
      const signed = signedBytes(readSignDataRequest([data, {encoding}]))

      expect(new TextDecoder().decode(signed).startsWith(`${MIDNIGHT_SIGNED_MESSAGE_PREFIX}:`)).toBe(true)
    }
  })
})
