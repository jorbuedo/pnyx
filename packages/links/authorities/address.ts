import {Effect} from 'effect'
import {InvalidUriError} from '../errors.js'
import type {AddressUri} from '../types.js'

/**
 * Parse an address URI
 * Format: web+cardano://address/<address>
 */
export const parse = (url: URL): Effect.Effect<AddressUri, InvalidUriError> =>
  Effect.gen(function* () {
    const pathParts = url.pathname.split('/').filter((p) => p.length > 0)

    if (pathParts.length === 0 || !pathParts[0]) {
      return yield* Effect.fail(
        new InvalidUriError({
          uri: url.href,
          reason: 'Address URI requires address in path: cardano://address/<address>',
        }),
      )
    }

    return {
      authority: 'address' as const,
      address: pathParts[0],
    }
  })

/**
 * Build an address URI
 */
export const build = (address: string): string => `web+cardano://address/${address}`
