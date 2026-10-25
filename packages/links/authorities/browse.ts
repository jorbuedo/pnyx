import {Effect} from 'effect'
import {InvalidUriError} from '../errors.js'
import type {BrowseUri} from '../types.js'

/**
 * Per CIP-0158, the only versioned segment defined today is `v1`.
 */
const SUPPORTED_VERSIONS = new Set(['v1'])

/**
 * Strict allowlist for the embedded `uri` parameter — CIP-0158 limits this to
 * `http(s):`. Other schemes (`javascript:`, `file:`, `data:`, brand schemes,
 * etc.) are rejected here so downstream consumers can route the URL to a
 * WebView without a second validation pass.
 */
const ALLOWED_INNER_PROTOCOLS = new Set(['http:', 'https:'])

/**
 * Parse a CIP-0158 browse URI.
 *
 * Format: `web+cardano://browse/<version>?uri=<percent_encoded_uri>`
 *  - `<version>` is required (currently only `v1`)
 *  - `uri` is required, percent-decoded, and must be an `http(s):` URL
 *  - If the inner URI omits a scheme, `https:` is assumed per CIP-0158
 */
export const parse = (url: URL): Effect.Effect<BrowseUri, InvalidUriError> =>
  Effect.gen(function* () {
    const pathParts = url.pathname.split('/').filter((p) => p.length > 0)
    const version = pathParts[0]

    if (!version) {
      return yield* Effect.fail(
        new InvalidUriError({
          uri: url.href,
          reason: 'Browse URI requires a version segment: web+cardano://browse/v1?uri=<url>',
        }),
      )
    }

    if (!SUPPORTED_VERSIONS.has(version)) {
      return yield* Effect.fail(
        new InvalidUriError({
          uri: url.href,
          reason: `Unsupported browse version "${version}". Supported: ${[...SUPPORTED_VERSIONS].join(', ')}`,
        }),
      )
    }

    const rawInnerUri = url.searchParams.get('uri')
    if (!rawInnerUri) {
      return yield* Effect.fail(
        new InvalidUriError({
          uri: url.href,
          reason: 'Browse URI requires a `uri` query parameter',
        }),
      )
    }

    // Default to https: when the inner URI omits a scheme — CIP-0158 §"the
    // browse authority". Apply BEFORE percent-decoding round-trip so we don't
    // accidentally re-add a scheme to a URL that already had one decoded.
    const candidate = /^[a-z][a-z0-9+.-]*:/i.test(rawInnerUri) ? rawInnerUri : `https://${rawInnerUri}`

    let innerUrl: URL
    try {
      innerUrl = new URL(candidate)
    } catch {
      return yield* Effect.fail(
        new InvalidUriError({
          uri: url.href,
          reason: `Browse \`uri\` is not a valid URL: "${rawInnerUri}"`,
        }),
      )
    }

    if (!ALLOWED_INNER_PROTOCOLS.has(innerUrl.protocol)) {
      return yield* Effect.fail(
        new InvalidUriError({
          uri: url.href,
          reason: `Browse \`uri\` must use http: or https:, got "${innerUrl.protocol}"`,
        }),
      )
    }

    return {
      authority: 'browse' as const,
      version: 'v1' as const,
      uri: innerUrl.href,
    }
  })

/**
 * Build a CIP-0158 browse URI.
 *
 * @param targetUrl - Destination `http(s)` URL.
 * @param version - Defaults to `v1`.
 */
export const build = (targetUrl: string, version: 'v1' = 'v1'): string => {
  const params = new URLSearchParams({uri: targetUrl})
  return `web+cardano://browse/${version}?${params}`
}
