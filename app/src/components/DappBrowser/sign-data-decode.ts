/**
 * Decode a CIP-30 `signData` payload (hex) into a human-reviewable form: a
 * structured SIWE/CIP-8-style login message, a plain UTF-8 string, or — when the
 * bytes aren't printable text — the raw hex. Pure; no React.
 *
 * @module
 */

import {logger} from '../../logger'

/** SIWE/CIP-8 login fields (EIP-4361-shaped; Cardano wallets reuse the format). */
export type SignDataSiwe = {
  readonly domain: string
  readonly address: string
  readonly statement: string | null
  readonly uri: string | null
  readonly version: string | null
  readonly chainId: string | null
  readonly nonce: string | null
  readonly issuedAt: string | null
}

export type DecodedSignData =
  | {readonly kind: 'siwe'; readonly fields: SignDataSiwe; readonly text: string}
  | {readonly kind: 'utf8'; readonly text: string}
  | {readonly kind: 'hex'; readonly hex: string}

const HEADER_RE = /^(.+) wants you to sign in with your (?:Ethereum|Cardano) account:\n(\S+)$/

const hexToUtf8 = (hex: string): string | null => {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  if (clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean)) return null
  const bytes = new Uint8Array((clean.match(/.{1,2}/g) ?? []).map((b) => Number.parseInt(b, 16)))
  try {
    return new TextDecoder('utf-8', {fatal: true}).decode(bytes)
  } catch (e: unknown) {
    // `fatal: true` makes the throw the answer: these bytes are not text, so the payload is
    // shown as hex instead. Not an error — but it must be separable from one.
    logger.debug('signData payload is not valid UTF-8; it will be shown as hex', {
      origin: 'sign-data-decode',
      error: String(e),
    })
    return null
  }
}

const parseSiwe = (text: string): SignDataSiwe | null => {
  const parts = text.split('\n\n')
  if (parts.length < 2) return null
  const headerMatch = parts[0]?.match(HEADER_RE)
  if (!headerMatch) return null
  const domain = headerMatch[1]
  const address = headerMatch[2]
  if (!domain || !address) return null

  const second = parts[1] ?? ''
  const isFieldBlock = second.startsWith('URI: ') || second.startsWith('\n')
  const statement = isFieldBlock ? null : second || null
  const fieldText = parts.slice(isFieldBlock ? 1 : 2).join('\n\n')
  const fields = new Map<string, string>()
  for (const line of fieldText.split('\n')) {
    const i = line.indexOf(': ')
    if (i > 0) fields.set(line.slice(0, i), line.slice(i + 2))
  }
  return {
    domain,
    address,
    statement,
    uri: fields.get('URI') ?? null,
    version: fields.get('Version') ?? null,
    chainId: fields.get('Chain ID') ?? null,
    nonce: fields.get('Nonce') ?? null,
    issuedAt: fields.get('Issued At') ?? null,
  }
}

/** Decode a hex signData payload into the richest representation available. */
export const decodeSignDataPayload = (payloadHex: string): DecodedSignData => {
  const text = hexToUtf8(payloadHex)
  if (text === null) return {kind: 'hex', hex: payloadHex.startsWith('0x') ? payloadHex.slice(2) : payloadHex}
  const siwe = parseSiwe(text)
  if (siwe !== null) return {kind: 'siwe', fields: siwe, text}
  return {kind: 'utf8', text}
}
