/**
 * Pure WebAuthn JSON helpers for the passkey PRF rail.
 *
 * The native side (Android Credential Manager, iOS ASAuthorization later) is a
 * pass-through over WebAuthn request/response JSON, so all request shaping and
 * response parsing lives here where it is unit-testable. Binary fields use
 * unpadded base64url per the WebAuthn JSON serialization
 * (PublicKeyCredentialCreationOptionsJSON / RegistrationResponseJSON).
 *
 * @module
 */

const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

/** Encode bytes as unpadded base64url (WebAuthn JSON binary encoding). */
export const base64UrlEncode = (bytes: Uint8Array): string => {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] as number
    const b1 = bytes[i + 1]
    const b2 = bytes[i + 2]
    out += BASE64URL_ALPHABET[b0 >> 2]
    out += BASE64URL_ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)]
    if (b1 !== undefined) out += BASE64URL_ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)]
    if (b2 !== undefined) out += BASE64URL_ALPHABET[b2 & 0x3f]
  }
  return out
}

/** Decode unpadded (or padded) base64url into bytes. Throws on a malformed alphabet. */
export const base64UrlDecode = (text: string): Uint8Array => {
  const stripped = text.replace(/=+$/, '')
  const values: number[] = []
  for (const char of stripped) {
    const value = BASE64URL_ALPHABET.indexOf(char)
    if (value === -1) throw new Error(`invalid base64url character: ${JSON.stringify(char)}`)
    values.push(value)
  }
  const out = new Uint8Array(Math.floor((values.length * 6) / 8))
  let bitBuffer = 0
  let bitCount = 0
  let index = 0
  for (const value of values) {
    bitBuffer = (bitBuffer << 6) | value
    bitCount += 6
    if (bitCount >= 8) {
      bitCount -= 8
      out[index++] = (bitBuffer >> bitCount) & 0xff
    }
  }
  return out
}

export type CreateRequestInput = {
  readonly rpId: string
  readonly rpName: string
  readonly userName: string
  /** Stable-ish user handle; 16–64 random bytes generated per enrollment. */
  readonly userId: Uint8Array
  /** Fresh random challenge; unused server-side (no attestation verification) but required by the API. */
  readonly challenge: Uint8Array
  /** PRF eval salt — the fixed domain-separated constant. */
  readonly prfSalt: Uint8Array
}

/**
 * Build a PublicKeyCredentialCreationOptionsJSON string with the PRF extension.
 * Resident key + user verification are required: the credential must be a
 * discoverable, biometric-gated, cloud-synced passkey for the recovery rail.
 */
export const buildCreateRequestJson = (input: CreateRequestInput): string =>
  JSON.stringify({
    rp: {id: input.rpId, name: input.rpName},
    user: {
      id: base64UrlEncode(input.userId),
      name: input.userName,
      displayName: input.userName,
    },
    challenge: base64UrlEncode(input.challenge),
    pubKeyCredParams: [
      {type: 'public-key', alg: -7},
      {type: 'public-key', alg: -257},
    ],
    timeout: 60_000,
    authenticatorSelection: {
      residentKey: 'required',
      requireResidentKey: true,
      userVerification: 'required',
    },
    extensions: {prf: {eval: {first: base64UrlEncode(input.prfSalt)}}},
  })

export type GetRequestInput = {
  readonly rpId: string
  readonly challenge: Uint8Array
  readonly prfSalt: Uint8Array
  /** Restrict the prompt to one credential (base64url id); omit to let the user pick. */
  readonly credentialId?: string | undefined
}

/** Build a PublicKeyCredentialRequestOptionsJSON string with the PRF extension. */
export const buildGetRequestJson = (input: GetRequestInput): string =>
  JSON.stringify({
    rpId: input.rpId,
    challenge: base64UrlEncode(input.challenge),
    timeout: 60_000,
    userVerification: 'required',
    ...(input.credentialId === undefined
      ? {}
      : {allowCredentials: [{type: 'public-key', id: input.credentialId, transports: ['internal', 'hybrid']}]}),
    extensions: {prf: {eval: {first: base64UrlEncode(input.prfSalt)}}},
  })

export type ParsedPasskeyResponse = {
  /** base64url credential id. */
  readonly credentialId: string
  /**
   * PRF output for the requested salt, or null when the authenticator did not
   * evaluate PRF (common on create — providers often report `enabled` only and
   * return outputs on the first get()).
   */
  readonly prfOutput: Uint8Array | null
}

/**
 * Parse a RegistrationResponseJSON / AuthenticationResponseJSON string,
 * extracting the credential id and the PRF `results.first` output when present.
 */
export const parsePasskeyResponseJson = (json: string): ParsedPasskeyResponse => {
  const parsed: unknown = JSON.parse(json)
  if (typeof parsed !== 'object' || parsed === null) throw new Error('passkey response is not a JSON object')
  const response = parsed as {
    id?: unknown
    rawId?: unknown
    clientExtensionResults?: {prf?: {results?: {first?: unknown}}}
  }
  const credentialId = typeof response.rawId === 'string' ? response.rawId : response.id
  if (typeof credentialId !== 'string' || credentialId.length === 0) {
    throw new Error('passkey response has no credential id')
  }
  const first = response.clientExtensionResults?.prf?.results?.first
  return {
    credentialId,
    prfOutput: typeof first === 'string' && first.length > 0 ? base64UrlDecode(first) : null,
  }
}
