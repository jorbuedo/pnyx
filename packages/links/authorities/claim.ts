import {Effect} from 'effect'
import {InvalidUriError} from '../errors.js'
import type {ClaimUri} from '../types.js'

/**
 * Faucet token claims — CIP-13's `claim` authority, specified by **CIP-99
 * (Proof of Onboarding, Active)**.
 *
 * CIP-13 shows this authority once as an example and points at "a separate CIP
 * for that protocol"; CIP-99 is that CIP. It fixes the grammar and, past the URI,
 * an API: the wallet POSTs `{address, code}` to `faucet_url` and reads a documented
 * status block back.
 *
 *     cardanourn    = "web+cardano:" claimtokenref
 *     claimtokenref = "//claim" claimversion claimquery
 *     claimversion  = "/v1"
 *     claimquery    = ( "?" claimurl) ( "&" claimcode)
 *
 * Two things the grammar alone does not say, both load-bearing here:
 *
 * - **Extra query parameters are part of the protocol.** CIP-99 requires them
 *   "passed through to the provided `faucet_url` without modification" — its own
 *   examples carry `invoice` and `user_id`. Dropping them hands the faucet a claim
 *   it cannot attribute, so they are parsed rather than discarded.
 * - **`faucet_url` must be https.** This app POSTs the user's receiving address to
 *   it, and an address sent in cleartext is a link between a person and their funds
 *   handed to anyone on the path. CIP-99 does not require the scheme; sending is
 *   ours to refuse, and refusing at the parse means no surface downstream has to
 *   remember to check.
 */
const SUPPORTED_VERSIONS = new Set(['v1'])

/** Reserved names — everything else in the query is the faucet's own. */
const PROTOCOL_PARAMS = new Set(['faucet_url', 'code'])

export const parse = (url: URL): Effect.Effect<ClaimUri, InvalidUriError> =>
  Effect.gen(function* () {
    const version = url.pathname.split('/').filter((p) => p.length > 0)[0]

    if (version === undefined || !SUPPORTED_VERSIONS.has(version)) {
      return yield* Effect.fail(
        new InvalidUriError({
          uri: url.href,
          reason: 'Claim URI requires a version segment: web+cardano://claim/v1?faucet_url=<url>&code=<code>',
        }),
      )
    }

    const rawFaucetUrl = url.searchParams.get('faucet_url') ?? ''
    const code = url.searchParams.get('code') ?? ''

    if (rawFaucetUrl === '' || code === '') {
      return yield* Effect.fail(
        new InvalidUriError({
          uri: url.href,
          reason: 'Claim URI requires both `faucet_url` and `code` query parameters',
        }),
      )
    }

    // Parsed to check the scheme, then discarded: `URL.href` normalises (a bare
    // host gains a trailing slash, reserved characters re-encode) and CIP-99 says
    // the faucet's own parameters reach it unmodified. The string that was scanned
    // is the string that gets posted to.
    let faucet: URL
    try {
      faucet = new URL(rawFaucetUrl)
    } catch {
      return yield* Effect.fail(
        new InvalidUriError({uri: url.href, reason: `Claim \`faucet_url\` is not a valid URL: "${rawFaucetUrl}"`}),
      )
    }

    if (faucet.protocol !== 'https:') {
      return yield* Effect.fail(
        new InvalidUriError({
          uri: url.href,
          reason: `Claim \`faucet_url\` must use https:, got "${faucet.protocol}"`,
        }),
      )
    }

    const params: Record<string, string> = {}
    for (const [key, value] of url.searchParams.entries()) {
      if (!PROTOCOL_PARAMS.has(key)) params[key] = value
    }

    return {authority: 'claim' as const, version, faucetUrl: rawFaucetUrl, code, params}
  })

export const build = (
  faucetUrl: string,
  code: string,
  version = 'v1',
  params: Readonly<Record<string, string>> = {},
): string => `web+cardano://claim/${version}?${new URLSearchParams({faucet_url: faucetUrl, code, ...params})}`
