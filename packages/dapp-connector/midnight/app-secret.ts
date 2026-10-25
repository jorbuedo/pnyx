/**
 * Reading a `deriveAppSecret` request, and the constants its answer is derived under.
 *
 * `deriveAppSecret` is **not** in `@midnight-ntwrk/dapp-connector-api`. It is a wallet extension
 * method proposed by Moth (`specs/003-derive-app-secret`), and the constants below are theirs —
 * deliberately vendor-neutral (`midnight:`, not a wallet's name) so that one seed derives the *same*
 * secret in every wallet that implements it. That is the whole value of the method: a dApp's per-user
 * secret must survive the user changing wallets. Byte-compatibility is therefore the specification,
 * and any change here is a `v2` tag rather than an edit.
 *
 * Why a dApp cannot do this itself: deriving from a public value (a coin public key, an address) is
 * recomputable by anyone who knows the address, so it is not secret; and `signData` here is
 * randomised, so it cannot seed anything reproducible. Only the holder of the seed can give a dApp a
 * secret that is private, deterministic and stateless at once.
 *
 * ⚠️ **`origin` is the wallet's, never the dApp's.** It is folded into `info` from the connection the
 * request arrived on. Taking it from the parameters would let one site ask for another site's secret,
 * which is the single thing this design has to prevent.
 *
 * @module
 */

import {invalidRequest} from '../resolver.js'
import type {WireError} from '../types.js'

/** Normative v1 tag — the salt, and the prefix of `info`. Pinned; see the module note. */
export const APP_SECRET_V1 = 'midnight:dapp-app-secret:v1'

/** Bytes of the derived secret. */
export const APP_SECRET_LENGTH = 32

/**
 * The longest `domain` accepted.
 *
 * A label, not a payload: it selects *which* secret a site wants. The bound and the printable-ASCII
 * rule come from the proposal, so a domain accepted by one wallet is accepted by ours.
 */
export const MAX_APP_SECRET_DOMAIN = 128

const PRINTABLE_ASCII = /^[\x20-\x7e]+$/

export type AppSecretRead =
  | {readonly ok: true; readonly domain: string}
  | {readonly ok: false; readonly error: WireError}

export const readAppSecretRequest = (params: unknown): AppSecretRead => {
  const args = Array.isArray(params) ? params : []
  const domain = args[0]
  if (typeof domain !== 'string' || domain.length === 0) {
    return {ok: false, error: invalidRequest('deriveAppSecret takes a domain label as a string')}
  }
  if (domain.length > MAX_APP_SECRET_DOMAIN) {
    return {
      ok: false,
      error: invalidRequest(`a domain label is at most ${MAX_APP_SECRET_DOMAIN} characters`),
    }
  }
  if (!PRINTABLE_ASCII.test(domain)) {
    // Normalisation is the hazard: two labels that look alike must not derive one secret, and
    // deciding *which* form to hash is a decision nobody should make on a dApp's behalf.
    return {ok: false, error: invalidRequest('a domain label must be printable ASCII')}
  }
  return {ok: true, domain}
}

/**
 * The HKDF `info` for one `(origin, domain)` pair.
 *
 * Pure, exported and tested because it *is* the compatibility surface: the separator, the order and
 * the tag are what make two wallets agree.
 */
export const appSecretInfo = (origin: string, domain: string): Uint8Array =>
  new TextEncoder().encode(`${APP_SECRET_V1}|${origin}|${domain}`)

/** The HKDF salt. A constant, per the proposal. */
export const appSecretSalt = (): Uint8Array => new TextEncoder().encode(APP_SECRET_V1)
