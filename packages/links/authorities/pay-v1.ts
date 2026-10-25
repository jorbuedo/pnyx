/**
 * CIP-157 — Cardano URIs, Enhanced Payments.
 *
 * `web+cardano://pay/v1/<address>?l=<lovelace>&i=<id>&n=<note>&t=<assets>`
 *
 * A CIP-13 extension that adds what CIP-13 predates: native assets (Mary shipped
 * after it), a payment identifier for point-of-sale and e-commerce, and a note the
 * sender reads. Status: Proposed (PR #843, Adam Dean; Begin Wallet implementing).
 *
 * Two shapes share the `pay` authority, which is why the version segment matters:
 * CIP-157 puts the address in the **path** after `/v1/`, and the older query form
 * puts it in `?address=`. Whichever is present decides, so both keep working.
 *
 * ⚠️ **`t=` names assets by CIP-14 fingerprint, which is a one-way hash of
 * (policy, name).** A fingerprint cannot be turned back into the `policyId.assetName`
 * a transaction output needs — it can only be *matched* against assets already known.
 * So this module parses and preserves fingerprints and never pretends to resolve
 * them; that is the wallet's job, and an unresolved one has to be surfaced rather
 * than dropped. Dropping it would build a payment that looks complete and is short a
 * token the requester asked for.
 *
 * @module
 */

import {Effect} from 'effect'
import {InvalidUriError} from '../errors.js'
import type {PayV1Uri, RequestedAsset} from '../types.js'

/**
 * A CIP-14 fingerprint: `asset1` then 38 lower-case bech32 characters.
 *
 * **38, not the 39 the CIP's ABNF says.** CIP-14 fingerprints are bech32 over a
 * 20-byte blake2b digest: ceil(160/5) = 32 data characters plus a 6-character
 * checksum. The CIP's own examples are all 38 — its grammar is off by one, and
 * following the grammar would reject every real fingerprint.
 *
 * Shape only, deliberately: verifying the checksum needs a bech32 decoder and this
 * package depends on nothing but `effect`. A fingerprint that passes here and fails
 * to match any known asset is surfaced by the wallet as unresolved, which is the same
 * outcome a bad checksum deserves.
 */
const ASSET_FINGERPRINT = /^asset1[023456789acdefghjklmnpqrstuvwxyz]{38}$/

/** The CIP's own limit: a note is at most 64 characters once decoded. */
const MAX_NOTE = 64
/** `i=` is letters, digits, dashes and underscores per the ABNF. */
const PAYMENT_ID = /^[A-Za-z0-9_-]+$/

/**
 * `asset1…*10,asset1…` → the requested assets.
 *
 * A quantity is optional and defaults to 1, which the CIP allows so a single-NFT
 * request stays short. Anything malformed fails the whole URI rather than being
 * skipped: a request for three tokens that silently became two is worse than one
 * that refused to open.
 */
const parseTokens = (raw: string, uri: string): Effect.Effect<readonly RequestedAsset[], InvalidUriError> =>
  Effect.forEach(raw.split(','), (entry) => {
    const [fingerprint, quantityRaw] = entry.split('*')
    if (fingerprint === undefined || !ASSET_FINGERPRINT.test(fingerprint)) {
      return Effect.fail(
        new InvalidUriError({uri, reason: `Invalid CIP-14 asset id: "${entry.split('*')[0] ?? entry}"`}),
      )
    }
    if (quantityRaw === undefined) return Effect.succeed({fingerprint, quantity: 1n})
    if (!/^\d+$/.test(quantityRaw)) {
      return Effect.fail(new InvalidUriError({uri, reason: `Invalid asset quantity: "${quantityRaw}"`}))
    }
    const quantity = BigInt(quantityRaw)
    if (quantity === 0n) {
      return Effect.fail(new InvalidUriError({uri, reason: 'Asset quantity cannot be zero'}))
    }
    return Effect.succeed({fingerprint, quantity})
  })

/**
 * Parse a CIP-157 payment URI. `url.pathname` is `/v1/<address>` for this shape.
 *
 * Returns `null` — via the caller's check, not here — when there is no version
 * segment; this is only called once the shape has been recognised.
 */
export const parse = (url: URL): Effect.Effect<PayV1Uri, InvalidUriError> =>
  Effect.gen(function* () {
    // `//pay/v1/addr…` puts `pay` in the host, so the path is `/v1/addr…`.
    const segments = url.pathname.split('/').filter((s) => s !== '')
    const [version, address] = segments
    if (version !== 'v1') {
      return yield* Effect.fail(new InvalidUriError({uri: url.href, reason: `Unsupported pay version "${version}"`}))
    }
    if (address === undefined || address === '') {
      return yield* Effect.fail(new InvalidUriError({uri: url.href, reason: 'Pay URI requires an address'}))
    }
    if (segments.length > 2) {
      return yield* Effect.fail(new InvalidUriError({uri: url.href, reason: 'Pay URI has trailing path segments'}))
    }

    const lovelaceRaw = url.searchParams.get('l')
    if (lovelaceRaw !== null && !/^\d+$/.test(lovelaceRaw)) {
      return yield* Effect.fail(
        new InvalidUriError({uri: url.href, reason: `Invalid lovelace amount: "${lovelaceRaw}"`}),
      )
    }

    const paymentId = url.searchParams.get('i') ?? undefined
    if (paymentId !== undefined && !PAYMENT_ID.test(paymentId)) {
      return yield* Effect.fail(new InvalidUriError({uri: url.href, reason: `Invalid payment id: "${paymentId}"`}))
    }

    // `URLSearchParams` has already percent-decoded this.
    const note = url.searchParams.get('n') ?? undefined
    if (note !== undefined && note.length > MAX_NOTE) {
      return yield* Effect.fail(
        new InvalidUriError({uri: url.href, reason: `Note exceeds ${MAX_NOTE} characters once decoded`}),
      )
    }

    const tokensRaw = url.searchParams.get('t')
    const assets = tokensRaw === null ? [] : yield* parseTokens(tokensRaw, url.href)

    return {
      authority: 'pay-v1' as const,
      address,
      ...(lovelaceRaw === null ? {} : {lovelace: BigInt(lovelaceRaw)}),
      ...(paymentId === undefined ? {} : {paymentId}),
      ...(note === undefined ? {} : {note}),
      assets,
    }
  })

/** Whether a `pay` URL is the CIP-157 shape rather than the older query one. */
export const isPayV1 = (url: URL): boolean => url.pathname.split('/').filter((s) => s !== '')[0] === 'v1'

/**
 * Build a CIP-157 payment URI.
 *
 * A quantity of 1 is written bare, as the CIP prefers — every byte counts in a QR,
 * and the reader defaults to 1.
 */
export const build = (params: {
  readonly address: string
  readonly lovelace?: bigint | undefined
  readonly paymentId?: string | undefined
  readonly note?: string | undefined
  readonly assets?: readonly RequestedAsset[] | undefined
}): string => {
  const query = new URLSearchParams()
  if (params.lovelace !== undefined && params.lovelace > 0n) query.set('l', params.lovelace.toString())
  if (params.paymentId !== undefined && params.paymentId !== '') query.set('i', params.paymentId)
  if (params.note !== undefined && params.note !== '') query.set('n', params.note)
  const assets = params.assets ?? []
  if (assets.length > 0) {
    query.set('t', assets.map((a) => (a.quantity === 1n ? a.fingerprint : `${a.fingerprint}*${a.quantity}`)).join(','))
  }
  const suffix = query.size === 0 ? '' : `?${query}`
  return `web+cardano://pay/v1/${params.address}${suffix}`
}
