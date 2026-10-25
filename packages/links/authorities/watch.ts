import {Effect} from 'effect'
import {InvalidUriError} from '../errors.js'
import type {WatchUri} from '../types.js'

/**
 * Watch-only wallet hand-off: an address to track, and optionally what to call it.
 *
 * Format: `web+cardano://watch/v1?address=<addr1…|stake1…>&name=<label>`
 *
 * No CIP defines this authority — there is no cross-wallet standard for handing
 * over a wallet to watch — so it follows CIP-13's own grammar (a versioned
 * authority with query parameters) rather than inventing a shape, and a wallet
 * that does not know it will reject it as an unknown authority rather than
 * mis-read it as something else.
 *
 * Watching is the one hand-off that is safe to act on from a message: it carries
 * a public address and nothing else. No key material, no signing capability, and
 * the receiving wallet can spend nothing it adds.
 *
 * The address is *not* validated here. This package holds no codec (that is
 * `@pnyx/cardano-core`, deliberately not a dependency), and the import screen
 * resolves the address against the network anyway — so validating the shape here
 * would duplicate a check while still not being the one that matters. Bounds are
 * enforced, so a link cannot carry an unbounded blob.
 */
const SUPPORTED_VERSIONS = new Set(['v1'])

/** Comfortably past a bech32 base address (~103) or a stake address (~59). */
const MAX_ADDRESS = 256
/** A wallet label, not prose. */
const MAX_NAME = 64

export const parse = (url: URL): Effect.Effect<WatchUri, InvalidUriError> =>
  Effect.gen(function* () {
    const version = url.pathname.split('/').filter((p) => p.length > 0)[0]

    if (version === undefined || !SUPPORTED_VERSIONS.has(version)) {
      return yield* Effect.fail(
        new InvalidUriError({
          uri: url.href,
          reason: 'Watch URI requires a version segment: web+cardano://watch/v1?address=<address>',
        }),
      )
    }

    const address = (url.searchParams.get('address') ?? '').trim()
    if (address === '' || address.length > MAX_ADDRESS) {
      return yield* Effect.fail(
        new InvalidUriError({
          uri: url.href,
          reason: 'Watch URI requires an `address` query parameter',
        }),
      )
    }

    // An over-long or blank name is dropped rather than rejected: the name is a
    // convenience, and refusing the whole hand-off over a label would be the
    // wrong trade. The import screen defaults it.
    const rawName = (url.searchParams.get('name') ?? '').trim()
    const name = rawName === '' || rawName.length > MAX_NAME ? undefined : rawName

    return {authority: 'watch' as const, version, address, ...(name === undefined ? {} : {name})}
  })

export const build = (address: string, name?: string, version = 'v1'): string => {
  const params = new URLSearchParams({address})
  if (name !== undefined && name.trim() !== '') params.set('name', name.trim())
  return `web+cardano://watch/${version}?${params}`
}
