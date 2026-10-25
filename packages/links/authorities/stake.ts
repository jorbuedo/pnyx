import {Effect} from 'effect'
import {InvalidUriError} from '../errors.js'
import type {StakeUri} from '../types.js'

/**
 * Parse a stake URI
 * Format: web+cardano://stake/<pool_id> or web+cardano://stake?pool=<pool_id>
 */
export const parse = (url: URL): Effect.Effect<StakeUri, InvalidUriError> =>
  Effect.gen(function* () {
    // Try path first
    const pathParts = url.pathname.split('/').filter((p) => p.length > 0)

    if (pathParts.length > 0 && pathParts[0]) {
      return {
        authority: 'stake' as const,
        poolId: pathParts[0],
      }
    }

    // Try query parameter
    const poolId = url.searchParams.get('pool') ?? url.searchParams.get('poolId')

    if (!poolId) {
      return yield* Effect.fail(
        new InvalidUriError({
          uri: url.href,
          reason: 'Stake URI requires pool ID in path or as pool/poolId parameter',
        }),
      )
    }

    return {
      authority: 'stake' as const,
      poolId,
    }
  })

/**
 * Build a stake URI
 */
export const build = (poolId: string): string => `web+cardano://stake/${poolId}`
