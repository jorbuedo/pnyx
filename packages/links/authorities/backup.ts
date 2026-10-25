import {Effect} from 'effect'
import {InvalidUriError} from '../errors.js'
import type {BackupUri} from '../types.js'

/**
 * Encrypted wallet-backup URI — a CIP-13 protocol keyword under `web+cardano:`.
 *
 * Format: `web+cardano://backup?v=1&enc=<base64url(json-envelope)>`
 *
 * `enc` carries a base64url-encoded self-describing JSON envelope (CIP-0301).
 * All secret material and metadata live inside the encrypted envelope; the URI
 * itself leaks nothing but the format version.
 */
export const parse = (url: URL): Effect.Effect<BackupUri, InvalidUriError> =>
  Effect.gen(function* () {
    const enc = url.searchParams.get('enc')

    if (!enc) {
      return yield* Effect.fail(
        new InvalidUriError({
          uri: url.href,
          reason: 'Backup URI requires an `enc` parameter with the encrypted envelope',
        }),
      )
    }

    const params: Record<string, string> = {}
    for (const [key, value] of url.searchParams) {
      if (key !== 'enc') {
        params[key] = value
      }
    }

    return {
      authority: 'backup' as const,
      enc,
      params,
    }
  })

/**
 * Build an encrypted-backup URI.
 *
 * @param enc - base64url-encoded JSON envelope.
 * @param params - Plaintext params (currently just `v`, the format version).
 */
export const build = (enc: string, params?: Record<string, string>): string => {
  const searchParams = new URLSearchParams({enc, ...params})
  return `web+cardano://backup?${searchParams}`
}
