/**
 * CIP-14 asset fingerprint — `asset1…`, the bech32 form of
 * `blake2b-160(policyId ‖ assetName)`.
 *
 * It exists because the two natural identifiers are both awkward to link with:
 * the raw `policyId + assetName` concatenation is long and opaque, and the
 * policy id alone does not identify an asset. Every Cardano explorer and tool
 * understands the fingerprint, so it is what an outbound link should carry.
 *
 * Computed locally: no request, works offline, and works for an asset no
 * indexer has ever seen.
 *
 * @module
 */

import {bech32, blake2b, hex} from '@pnyx/crypto'
import {Either} from 'effect'
import {logger} from '../../logger'

/** A Cardano policy id is 28 bytes = 56 hex chars. */
const POLICY_HEX_LEN = 56

/** CIP-14 digest width: 160 bits. */
const FINGERPRINT_BYTES = 20

/**
 * `asset1…` for an app asset id (`"policyHex.assetNameHex"`), or `null` when the
 * id is not a well-formed asset (ADA, a malformed id). `null` means "no
 * fingerprint", so a caller must omit the link rather than build a broken one.
 */
export const assetFingerprint = (assetId: string): string | null => {
  const dot = assetId.indexOf('.')
  if (dot !== POLICY_HEX_LEN) return null
  const combined = `${assetId.slice(0, dot)}${assetId.slice(dot + 1)}`
  const bytes = hex.decode(combined)
  if (Either.isLeft(bytes)) return null
  try {
    return bech32.encode('asset', bech32.toWords(blake2b(bytes.right, FINGERPRINT_BYTES)))
  } catch (e: unknown) {
    // `null` is also the "not valid hex" branch above. A fingerprint is what keys an asset's
    // media and its explorer link, so an asset silently losing one is worth a line.
    logger.warn('Asset fingerprint could not be derived', {origin: 'asset-fingerprint', error: String(e)})
    return null
  }
}
