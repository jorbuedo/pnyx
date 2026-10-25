import {Effect} from 'effect'
import type {InvalidUriError} from '../errors.js'
import type {ConnectUri} from '../types.js'

/**
 * Parse a connect URI
 * Format: web+cardano://connect?<params>
 */
export const parse = (url: URL): Effect.Effect<ConnectUri, InvalidUriError> =>
  Effect.sync(() => {
    const params: Record<string, string> = {}

    for (const [key, value] of url.searchParams) {
      params[key] = value
    }

    return {
      authority: 'connect' as const,
      params,
    }
  })

/**
 * Build a connect URI
 */
export const build = (params: Record<string, string>): string => {
  const searchParams = new URLSearchParams(params)
  return `web+cardano://connect?${searchParams}`
}
