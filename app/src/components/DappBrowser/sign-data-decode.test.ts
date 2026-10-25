import {describe, expect, it} from 'vitest'
import {decodeSignDataPayload} from './sign-data-decode'

const toHex = (s: string): string => Buffer.from(s, 'utf8').toString('hex')

describe('decodeSignDataPayload', () => {
  it('decodes a printable UTF-8 message', () => {
    const decoded = decodeSignDataPayload(toHex('hello pnyx'))
    expect(decoded).toEqual({kind: 'utf8', text: 'hello pnyx'})
  })

  it('parses a SIWE/CIP-8 sign-in message (Cardano)', () => {
    const msg =
      'app.example.com wants you to sign in with your Cardano account:\naddr1xyz\n\n' +
      'Log in.\n\nURI: https://app.example.com\nVersion: 1\nChain ID: 1\nNonce: abc123\nIssued At: 2026-07-13T00:00:00Z'
    const decoded = decodeSignDataPayload(toHex(msg))
    expect(decoded.kind).toBe('siwe')
    if (decoded.kind !== 'siwe') return
    expect(decoded.fields.domain).toBe('app.example.com')
    expect(decoded.fields.address).toBe('addr1xyz')
    expect(decoded.fields.statement).toBe('Log in.')
    expect(decoded.fields.uri).toBe('https://app.example.com')
    expect(decoded.fields.nonce).toBe('abc123')
    expect(decoded.fields.issuedAt).toBe('2026-07-13T00:00:00Z')
  })

  it('parses the Ethereum SIWE header variant', () => {
    const msg = 'ex.io wants you to sign in with your Ethereum account:\n0xabc\n\nURI: https://ex.io\nNonce: n1'
    const decoded = decodeSignDataPayload(toHex(msg))
    expect(decoded.kind).toBe('siwe')
  })

  it('falls back to hex for non-UTF-8 bytes', () => {
    const decoded = decodeSignDataPayload('deadbeeffe')
    expect(decoded).toEqual({kind: 'hex', hex: 'deadbeeffe'})
  })

  it('strips a 0x prefix on the hex fallback', () => {
    const decoded = decodeSignDataPayload('0xfffe')
    expect(decoded).toEqual({kind: 'hex', hex: 'fffe'})
  })

  it('treats a printable string that is not SIWE as utf8', () => {
    const decoded = decodeSignDataPayload(toHex('just a note, not a login'))
    expect(decoded.kind).toBe('utf8')
  })
})
