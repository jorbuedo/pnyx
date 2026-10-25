/**
 * Conversions between the app's asset-id form and SteelSwap's `unit` form.
 *
 * - App id: `"policyHex.assetNameHex"` (dot-separated); ADA is `''` or `'.'`.
 * - SteelSwap unit: `"policyHex"+"assetNameHex"` (concatenated, no separator);
 *   ADA is the empty string `''`.
 *
 * Both are pure and total; a malformed id round-trips to `null` rather than a
 * fabricated value.
 *
 * @module
 */

/**
 * The ids ADA itself answers to: the empty asset id, and the `policy.name` form of it.
 *
 * ⚠️ Defined here rather than in `token-metadata.ts` because it is a fact about asset ids, and because
 * importing it from there made the two modules import each other.
 */
export const ADA_ASSET_IDS: ReadonlySet<string> = new Set(['', '.'])

/** A Cardano policy id is 28 bytes = 56 hex chars. */
const POLICY_HEX_LEN = 56

/**
 * App id (`policy.name`) → SteelSwap unit (`policy+name`). ADA → `''`.
 * Returns `null` when the id is not a well-formed `policy.name` pair.
 */
export const assetIdToUnit = (assetId: string): string | null => {
  if (ADA_ASSET_IDS.has(assetId)) return ''
  const dot = assetId.indexOf('.')
  if (dot === -1) return null
  const policy = assetId.slice(0, dot)
  const name = assetId.slice(dot + 1)
  if (policy.length !== POLICY_HEX_LEN) return null
  return `${policy}${name}`
}

/**
 * SteelSwap unit (`policy+name`) → app id (`policy.name`). `''` → `''` (ADA).
 * Returns `null` when the unit is shorter than a policy id.
 */
export const unitToAssetId = (unit: string): string | null => {
  if (unit.length === 0) return ''
  if (unit.length < POLICY_HEX_LEN) return null
  return `${unit.slice(0, POLICY_HEX_LEN)}.${unit.slice(POLICY_HEX_LEN)}`
}
