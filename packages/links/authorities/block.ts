import {Effect} from 'effect'
import {InvalidUriError} from '../errors.js'
import type {BlockUri} from '../types.js'

/**
 * Parse a block URI
 * Format: web+cardano://block/<hash>
 */
export const parse = (url: URL): Effect.Effect<BlockUri, InvalidUriError> =>
  Effect.gen(function* () {
    const pathParts = url.pathname.split('/').filter((p) => p.length > 0)

    if (pathParts.length === 0 || !pathParts[0]) {
      return yield* Effect.fail(
        new InvalidUriError({
          uri: url.href,
          reason: 'Block URI requires hash in path: cardano://block/<hash>',
        }),
      )
    }

    return {
      authority: 'block' as const,
      hash: pathParts[0],
    }
  })

/**
 * Build a block URI
 */
export const build = (hash: string): string => `web+cardano://block/${hash}`
