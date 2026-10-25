/**
 * The first-party media URL for a Cardano asset's list icon.
 *
 * Pure and host-parameterised so it is testable without the env: `config.ts` binds the configured
 * host, this decides the shape.
 *
 * Keyed by **CIP-14 fingerprint** because that is what the media store is keyed by, and because the
 * wallet derives it locally — building the URL needs no request, and works for an asset no indexer
 * has ever seen.
 *
 * @module
 */

import {assetFingerprint} from './asset-fingerprint'

/**
 * Size ceiling, not a guarantee.
 *
 * The store never upscales: a 64px source is kept at 64px rather than blown up to 256 and served as
 * if it carried detail it does not have. So a response may be smaller than this in either dimension,
 * and may not be square — callers must render with `contentFit` and must not assume 256×256.
 */
export const MEDIA_ICON_SIZE = 256

/**
 * `${host}/${fingerprint}/256.webp`, or `null` when there is nothing to ask for.
 *
 * `null` means "do not request", and it has two distinct causes, both correct:
 *  - no host configured — the feature is opt-in, and the caller keeps its placeholder;
 *  - the id is not a well-formed asset (ADA, malformed) — there is no fingerprint to key on.
 */
export const mediaIconUrl = (host: string | undefined, assetId: string): string | null => {
  if (host === undefined || host.length === 0) return null
  const fingerprint = assetFingerprint(assetId)
  if (fingerprint === null) return null
  return `${host.replace(/\/+$/, '')}/${fingerprint}/${MEDIA_ICON_SIZE}.webp`
}
