import {Effect} from 'effect'
import {InvalidUriError} from '../errors.js'
import type {TransactionUri} from '../types.js'

/**
 * Parse a transaction URI
 * Format: web+cardano://transaction/<hash>
 */
export const parse = (url: URL): Effect.Effect<TransactionUri, InvalidUriError> =>
  Effect.gen(function* () {
    const pathParts = url.pathname.split('/').filter((p) => p.length > 0)

    if (pathParts.length === 0 || !pathParts[0]) {
      return yield* Effect.fail(
        new InvalidUriError({
          uri: url.href,
          reason: 'Transaction URI requires hash in path: web+cardano://transaction/<hash>',
        }),
      )
    }

    return {
      authority: 'transaction' as const,
      hash: pathParts[0],
    }
  })

/**
 * Build a transaction URI
 */
export const build = (hash: string): string => `web+cardano://transaction/${hash}`
