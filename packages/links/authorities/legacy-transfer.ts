import {Effect} from 'effect'
import type {InvalidUriError} from '../errors.js'
import type {LegacyTransferUri} from '../types.js'

/**
 * Parse a legacy-transfer URI
 * Format: web+cardano://legacy-transfer?<params>
 */
export const parse = (url: URL): Effect.Effect<LegacyTransferUri, InvalidUriError> =>
  Effect.sync(() => {
    const params: Record<string, string> = {}

    for (const [key, value] of url.searchParams) {
      params[key] = value
    }

    return {
      authority: 'legacy-transfer' as const,
      params,
    }
  })

/**
 * Build a legacy-transfer URI
 */
export const build = (params: Record<string, string>): string => {
  const searchParams = new URLSearchParams(params)
  return `web+cardano://legacy-transfer?${searchParams}`
}
