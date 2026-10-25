/**
 * Reading a `signData` request, and the shape of the answer.
 *
 * The payload arrives as a string plus an `encoding`, and turning it into bytes is the whole of the
 * protocol here — so it is a pure function with the awkward cases pinned, rather than three lines
 * inlined next to a signing call.
 *
 * ⚠️ **`'text'` means UTF-8, and that is a conversion, not a cast.** JS strings are UTF-16, so the
 * wallet must encode to UTF-8 before signing; a dApp verifying against the UTF-8 bytes of the same
 * string would otherwise get a signature over different data. The API calls this out explicitly, which
 * is a good sign it has bitten someone.
 *
 * ⚠️ **What gets signed is the decoded payload inside a domain-separated envelope**, never the payload
 * itself — see {@link signedMessageBytes}. The unshielded key that answers `signData` is the same key
 * that authorises unshielded spends, and the ledger authorises one by signing
 * `b"midnight:hash-intent:" ‖ segment_id ‖ intent` with `SigningKey::sign` — the identical primitive
 * over caller-chosen bytes. Without a prefix a dApp can hand over an intent's `data_to_sign` as `hex`
 * and receive a valid spend authorisation for it. Every payload the ledger signs is tagged `midnight:`
 * (intents, claim-rewards, contract-update), so one envelope excludes all of them at once.
 *
 * @module
 */

import type {Signature} from '@midnight-ntwrk/dapp-connector-api'
import {invalidRequest} from '../resolver.js'
import type {WireError} from '../types.js'

/** The scheme this wallet signs with. Always stated, never left to a reader's default — see below. */
export const MIDNIGHT_SIGNATURE_SCHEME = 'schnorr_bip340' as const

/** The connector's domain tag for a signed message. */
export const MIDNIGHT_SIGNED_MESSAGE_PREFIX = 'midnight_signed_message'

/**
 * The exact bytes signed for a `signData` payload: `utf8("midnight_signed_message:<len>:") ‖ payload`.
 *
 * The length is the decoded payload's byte length, so the prefix cannot be spliced by a payload that
 * starts with a plausible-looking header. Exported because a verifier has to rebuild it: a dApp
 * checking a signature against the payload alone will fail, correctly.
 *
 * This is the wire convention other Midnight wallets sign, so it is also what makes our signatures
 * verifiable by a dApp that was written against one of them.
 */
export const signedMessageBytes = (payload: Uint8Array): Uint8Array => {
  const prefix = new TextEncoder().encode(`${MIDNIGHT_SIGNED_MESSAGE_PREFIX}:${payload.length}:`)
  const out = new Uint8Array(prefix.length + payload.length)
  out.set(prefix, 0)
  out.set(payload, prefix.length)
  return out
}

export type SignDataRequest = {
  /**
   * The bytes to sign: the payload decoded from the requested encoding, wrapped by
   * {@link signedMessageBytes}. Never the bare payload — that is the whole point of the module.
   */
  readonly message: Uint8Array
  /** The payload exactly as the dApp sent it, echoed back in the result. */
  readonly data: string
}

/**
 * A read request, or the reason it was refused.
 *
 * ⚠️ **Explicitly tagged rather than `SignDataRequest | WireError`.** `WireError` extends `Error`, so it
 * has a `message` property of its own — the obvious `'message' in result` check matches *both* branches,
 * and a caller that used it would treat every refusal as a valid request and sign arbitrary bytes. A
 * union that cannot be discriminated wrongly is worth two extra characters at each call site.
 */
export type SignDataRead =
  | {readonly ok: true; readonly request: SignDataRequest}
  | {readonly ok: false; readonly error: WireError}

const HEX = /^[0-9a-fA-F]*$/
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

const fromHex = (text: string): Uint8Array => {
  const out = new Uint8Array(text.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16)
  return out
}

const fromBase64 = (text: string): Uint8Array => {
  // `atob` is present in Hermes and in every browser; `Buffer` is not, on either.
  const binary = atob(text)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

/**
 * Decode a `signData` payload, or refuse it.
 *
 * Refusing matters more than it looks: a malformed hex string quietly read as text would have the
 * wallet sign something the dApp never asked for, and the signature would verify — over the wrong
 * bytes. So each encoding is validated for its own alphabet and nothing falls back to another.
 */
export const readSignDataRequest = (params: unknown): SignDataRead => {
  const args = Array.isArray(params) ? params : []
  const [data, options] = args
  const no = (error: WireError): SignDataRead => ({ok: false, error})
  if (typeof data !== 'string') return no(invalidRequest('signData takes the data to sign as a string'))
  const encoding = (options as {encoding?: unknown} | undefined)?.encoding
  const keyType = (options as {keyType?: unknown} | undefined)?.keyType
  if (keyType !== undefined && keyType !== 'unshielded') {
    // The only key kind the API defines. A shielded key cannot sign this, so a request naming one is a
    // misunderstanding worth reporting rather than quietly answering with the unshielded key.
    return no(invalidRequest(`signData supports keyType 'unshielded', not '${String(keyType)}'`))
  }
  switch (encoding) {
    case 'text':
      // The conversion the API asks for: UTF-16 in, UTF-8 out.
      return {ok: true, request: {message: signedMessageBytes(new TextEncoder().encode(data)), data}}
    case 'hex':
      if (data.length % 2 !== 0 || !HEX.test(data)) return no(invalidRequest('signData: data is not valid hex'))
      return {ok: true, request: {message: signedMessageBytes(fromHex(data)), data}}
    case 'base64':
      if (!BASE64.test(data) || data.length % 4 !== 0) {
        return no(invalidRequest('signData: data is not valid base64'))
      }
      try {
        return {ok: true, request: {message: signedMessageBytes(fromBase64(data)), data}}
      } catch (error) {
        return no(invalidRequest(`signData: data is not valid base64 (${error instanceof Error ? error.message : ''})`))
      }
    default:
      return no(invalidRequest(`signData needs an encoding of 'hex', 'base64' or 'text', not '${String(encoding)}'`))
  }
}

/**
 * Assemble the result a dApp receives.
 *
 * ⚠️ **`scheme` is always set**, even though the API makes it optional and defaults an absent value to
 * `schnorr_bip340`. Relying on that default would be the same bug this codebase keeps finding: a field
 * whose absence silently means something. Stating it also survives the API making it mandatory, which
 * its own comment says is coming.
 */
export const signatureResult = (params: {
  readonly data: string
  readonly signatureHex: string
  readonly verifyingKeyHex: string
}): Signature => ({
  scheme: MIDNIGHT_SIGNATURE_SCHEME,
  data: params.data,
  signature: params.signatureHex,
  verifyingKey: params.verifyingKeyHex,
})
