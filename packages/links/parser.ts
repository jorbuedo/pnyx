import {Effect} from 'effect'
import * as Address from './authorities/address.js'
import * as Backup from './authorities/backup.js'
import * as Block from './authorities/block.js'
import * as Browse from './authorities/browse.js'
import * as Claim from './authorities/claim.js'
import * as Connect from './authorities/connect.js'
import * as Drep from './authorities/drep.js'
import * as LegacyTransfer from './authorities/legacy-transfer.js'
import * as Pay from './authorities/pay.js'
import * as PayV1 from './authorities/pay-v1.js'
import * as Stake from './authorities/stake.js'
import * as Transaction from './authorities/transaction.js'
import * as Watch from './authorities/watch.js'
import {InvalidUriError} from './errors.js'
import type {CardanoUri, ParsedUri, UriAuthority} from './types.js'

/**
 * The CIP-13 standard protocol for Cardano URIs.
 */
const CARDANO_PROTOCOL = 'web+cardano:'

/**
 * Authority parsers map
 */
const AUTHORITY_PARSERS: Record<UriAuthority, (url: URL) => Effect.Effect<ParsedUri, InvalidUriError>> = {
  claim: Claim.parse,
  watch: Watch.parse,
  browse: Browse.parse,
  // Two shapes share this authority. CIP-157 puts the address in the path after
  // `/v1/`; the older query form puts it in `?address=`. Whichever is present
  // decides, so both keep working and the newer one is not a breaking change.
  pay: (url) => (PayV1.isPayV1(url) ? PayV1.parse(url) : Pay.parse(url)),
  payment: Pay.parse, // Alias for pay
  // Never reached through an authority lookup — `pay-v1` is not a hostname, it is
  // what the `pay` branch above resolves to. Present so the record stays total.
  'pay-v1': PayV1.parse,
  stake: Stake.parse,
  drep: Drep.parse,
  transaction: Transaction.parse,
  block: Block.parse,
  address: Address.parse,
  connect: Connect.parse,
  backup: Backup.parse,
  'legacy-transfer': LegacyTransfer.parse,
}

/**
 * Parse a Cardano URI into its components
 *
 * Supported URI formats (web+cardano:// is standard, cardano:// accepted as legacy):
 * - web+cardano://claim/v1?faucet_url=<https_url>&code=<code>  (CIP-99)
 * - web+cardano://browse/v1?uri=<percent_encoded_https_url>  (CIP-0158)
 * - web+cardano://pay/v1/<address>?l=<lovelace>&i=<id>&n=<note>&t=<assets>  (CIP-157)
 * - web+cardano://pay?address=<addr>&amount=<lovelace>&message=<msg>
 * - web+cardano://payment?... (alias for pay)
 * - web+cardano://stake/<pool_id>
 * - web+cardano://drep/<drep_id>
 * - web+cardano://transaction/<hash>
 * - web+cardano://block/<hash>
 * - web+cardano://address/<address>
 * - web+cardano://watch/v1?address=<address>&name=<label>
 * - web+cardano://connect?<params>
 * - web+cardano://backup?v=1&enc=<base64url(json)>  (CIP-0301 encrypted wallet export)
 * - web+cardano://legacy-transfer?<params>
 * - web+cardano:<address>?amount=<lovelace>&memo=<msg> (legacy CIP-13)
 */
export const parse = (uri: CardanoUri | string): Effect.Effect<ParsedUri, InvalidUriError> =>
  Effect.gen(function* () {
    // Parse URL
    let url: URL
    try {
      url = new URL(uri)
    } catch {
      return yield* Effect.fail(
        new InvalidUriError({
          uri,
          reason: 'Invalid URL format',
        }),
      )
    }

    // Verify protocol — web+cardano: (CIP-13).
    if (url.protocol !== CARDANO_PROTOCOL) {
      return yield* Effect.fail(
        new InvalidUriError({
          uri,
          reason: `Expected web+cardano: protocol, got ${url.protocol}`,
        }),
      )
    }

    // Legacy CIP-13: web+cardano:<address>?amount=...&memo=...
    // When there's no //, hostname is empty and the address is in the pathname.
    if (url.protocol === CARDANO_PROTOCOL && !url.hostname && url.pathname) {
      const address = url.pathname
      if (/^[A-Za-z0-9_]+$/.test(address)) {
        return yield* Pay.parse(new URL(`web+cardano://pay?address=${encodeURIComponent(address)}&${url.searchParams}`))
      }
    }

    // Get authority (hostname in URL terms)
    const authority = url.hostname as UriAuthority

    // Find parser for authority.
    //
    // ⚠️ `Object.hasOwn` before the lookup, because `authority` is attacker-controlled and a plain
    // object literal resolves through `Object.prototype`: `web+cardano://constructor/`,
    // `//__proto__/`, `//toString/`, `//valueOf/` and `//hasOwnProperty/` each returned a truthy
    // non-parser that passed the `!parser` guard and then threw on call. A thrown error here is a
    // **defect**, not an `InvalidUriError`, so it escaped this function's typed failure channel
    // entirely — `Effect.either` does not catch it and `parseQrContent`'s `Effect.runSync` rethrows,
    // crashing whichever screen scanned the code.
    const parser = Object.hasOwn(AUTHORITY_PARSERS, authority) ? AUTHORITY_PARSERS[authority] : undefined

    if (!parser) {
      const validAuthorities = Object.keys(AUTHORITY_PARSERS).join(', ')
      return yield* Effect.fail(
        new InvalidUriError({
          uri,
          reason: `Unknown authority "${authority}". Valid authorities: ${validAuthorities}`,
        }),
      )
    }

    // Parse with authority-specific parser
    return yield* parser(url)
  })

/**
 * Build a Cardano URI from parsed components
 */
export const build = (parsed: ParsedUri): CardanoUri => {
  switch (parsed.authority) {
    case 'claim':
      return Claim.build(parsed.faucetUrl, parsed.code, parsed.version, parsed.params) as CardanoUri
    case 'watch':
      return Watch.build(parsed.address, parsed.name, parsed.version) as CardanoUri
    case 'browse':
      return Browse.build(parsed.uri, parsed.version) as CardanoUri
    case 'pay':
      return Pay.build(parsed.address, parsed.amount, parsed.message) as CardanoUri
    case 'pay-v1':
      return PayV1.build(parsed) as CardanoUri
    case 'stake':
      return Stake.build(parsed.poolId) as CardanoUri
    case 'drep':
      return Drep.build(parsed.drepId) as CardanoUri
    case 'transaction':
      return Transaction.build(parsed.hash) as CardanoUri
    case 'block':
      return Block.build(parsed.hash) as CardanoUri
    case 'address':
      return Address.build(parsed.address) as CardanoUri
    case 'connect':
      return Connect.build(parsed.params) as CardanoUri
    case 'backup':
      return Backup.build(parsed.enc, parsed.params) as CardanoUri
    case 'legacy-transfer':
      return LegacyTransfer.build(parsed.params) as CardanoUri
  }
}

/**
 * Check if a string is a valid Cardano URI (web+cardano:// or legacy web+cardano:<address>).
 */
export const isCardanoUri = (uri: string): uri is CardanoUri => {
  try {
    const url = new URL(uri)
    return url.protocol === CARDANO_PROTOCOL
  } catch {
    return false
  }
}
