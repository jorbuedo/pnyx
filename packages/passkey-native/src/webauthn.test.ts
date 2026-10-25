import {describe, expect, it} from 'vitest'
import {
  base64UrlDecode,
  base64UrlEncode,
  buildCreateRequestJson,
  buildGetRequestJson,
  parsePasskeyResponseJson,
} from './webauthn.js'

const bytes = (...values: number[]) => new Uint8Array(values)

describe('base64url codec', () => {
  it('encodes without padding using the url-safe alphabet', () => {
    // 0xfb 0xff is '+/8=' in standard base64 — must become '-_8' here.
    expect(base64UrlEncode(bytes(0xfb, 0xff))).toBe('-_8')
    expect(base64UrlEncode(bytes())).toBe('')
    expect(base64UrlEncode(new TextEncoder().encode('hello world'))).toBe('aGVsbG8gd29ybGQ')
  })

  it('round-trips all byte-length remainders and tolerates padding', () => {
    for (const input of [bytes(1), bytes(1, 2), bytes(1, 2, 3), bytes(0, 255, 128, 7, 66)]) {
      expect(base64UrlDecode(base64UrlEncode(input))).toEqual(input)
    }
    expect(base64UrlDecode('aGVsbG8gd29ybGQ='.replace(' ', ''))).toBeDefined()
    expect(base64UrlDecode('-_8=')).toEqual(bytes(0xfb, 0xff))
  })

  it('rejects characters outside the alphabet', () => {
    expect(() => base64UrlDecode('a+b/c')).toThrow(/invalid base64url/)
  })
})

describe('buildCreateRequestJson', () => {
  it('produces a WebAuthn creation request with the PRF extension and resident key', () => {
    const json = buildCreateRequestJson({
      rpId: 'pnyx.pxkq.uk',
      rpName: 'Pnyx',
      userName: 'My Account',
      userId: bytes(1, 2, 3, 4),
      challenge: bytes(9, 8, 7),
      prfSalt: bytes(0xaa, 0xbb),
    })
    const request = JSON.parse(json)
    expect(request.rp).toEqual({id: 'pnyx.pxkq.uk', name: 'Pnyx'})
    expect(request.user.name).toBe('My Account')
    expect(request.user.id).toBe(base64UrlEncode(bytes(1, 2, 3, 4)))
    expect(request.challenge).toBe(base64UrlEncode(bytes(9, 8, 7)))
    expect(request.pubKeyCredParams).toEqual([
      {type: 'public-key', alg: -7},
      {type: 'public-key', alg: -257},
    ])
    expect(request.authenticatorSelection).toEqual({
      residentKey: 'required',
      requireResidentKey: true,
      userVerification: 'required',
    })
    expect(request.extensions.prf.eval.first).toBe(base64UrlEncode(bytes(0xaa, 0xbb)))
  })
})

describe('buildGetRequestJson', () => {
  it('targets a specific credential when an id is given', () => {
    const json = buildGetRequestJson({
      rpId: 'pnyx.pxkq.uk',
      challenge: bytes(1),
      prfSalt: bytes(2),
      credentialId: 'AQIDBA',
    })
    const request = JSON.parse(json)
    expect(request.rpId).toBe('pnyx.pxkq.uk')
    expect(request.userVerification).toBe('required')
    expect(request.allowCredentials).toEqual([{type: 'public-key', id: 'AQIDBA', transports: ['internal', 'hybrid']}])
    expect(request.extensions.prf.eval.first).toBe(base64UrlEncode(bytes(2)))
  })

  it('omits allowCredentials for a discoverable-credential prompt', () => {
    const request = JSON.parse(buildGetRequestJson({rpId: 'pnyx.pxkq.uk', challenge: bytes(1), prfSalt: bytes(2)}))
    expect(request.allowCredentials).toBeUndefined()
  })
})

describe('parsePasskeyResponseJson', () => {
  const prf = bytes(...Array.from({length: 32}, (_, i) => i))

  it('extracts credential id and PRF output', () => {
    const parsed = parsePasskeyResponseJson(
      JSON.stringify({
        id: 'cred-id',
        rawId: 'cred-raw-id',
        type: 'public-key',
        clientExtensionResults: {prf: {results: {first: base64UrlEncode(prf)}}},
      }),
    )
    expect(parsed.credentialId).toBe('cred-raw-id')
    expect(parsed.prfOutput).toEqual(prf)
  })

  it('falls back to id when rawId is missing and reports null PRF when not evaluated', () => {
    const parsed = parsePasskeyResponseJson(
      JSON.stringify({id: 'cred-id', type: 'public-key', clientExtensionResults: {prf: {enabled: true}}}),
    )
    expect(parsed.credentialId).toBe('cred-id')
    expect(parsed.prfOutput).toBeNull()
  })

  it('rejects responses without a credential id or non-object payloads', () => {
    expect(() => parsePasskeyResponseJson(JSON.stringify({type: 'public-key'}))).toThrow(/no credential id/)
    expect(() => parsePasskeyResponseJson('"just a string"')).toThrow(/not a JSON object/)
  })
})
