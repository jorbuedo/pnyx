import {Effect} from 'effect'
import {InvalidUriError} from '../errors.js'
import type {DrepUri} from '../types.js'

/**
 * Parse a drep URI
 * Format: web+cardano://drep/<drep_id> or web+cardano://drep?id=<drep_id>
 */
export const parse = (url: URL): Effect.Effect<DrepUri, InvalidUriError> =>
  Effect.gen(function* () {
    // Try path first
    const pathParts = url.pathname.split('/').filter((p) => p.length > 0)

    if (pathParts.length > 0 && pathParts[0]) {
      return {
        authority: 'drep' as const,
        drepId: pathParts[0],
      }
    }

    // Try query parameter
    const drepId = url.searchParams.get('id') ?? url.searchParams.get('drepId')

    if (!drepId) {
      return yield* Effect.fail(
        new InvalidUriError({
          uri: url.href,
          reason: 'DRep URI requires DRep ID in path or as id/drepId parameter',
        }),
      )
    }

    return {
      authority: 'drep' as const,
      drepId,
    }
  })

/**
 * Build a drep URI
 */
export const build = (drepId: string): string => `web+cardano://drep/${drepId}`
