/**
 * Deterministic wallet profile derivation.
 *
 * Maps a checksum seed to a (colorIndex, iconIndex) pair for visual wallet identity.
 * Less variation than Jazzicon/Blockies (~1k combinations vs millions), but maps to
 * discrete icon + color pairs for UI avatar display.
 *
 * @module
 */

/**
 * Wallet profile — deterministic color + icon indices derived from a checksum seed.
 */
export type WalletProfile = {
  /** Index into the consumer's color palette */
  readonly colorIndex: number
  /** Index into the consumer's icon catalog */
  readonly iconIndex: number
}

/**
 * Derive a deterministic wallet profile from a checksum seed.
 *
 * Uses the first 4 hex characters of the seed for color selection and the next 4
 * for icon selection, modulo the provided palette/catalog sizes.
 *
 * @param seed - Hex string seed (e.g. from walletChecksum().seed)
 * @param colorCount - Number of available colors in the palette
 * @param iconCount - Number of available icons in the catalog
 *
 * @example
 * ```ts
 * const profile = walletProfile(checksum.seed, 21, 49)
 * const color = MY_COLORS[profile.colorIndex]
 * const icon = MY_ICONS[profile.iconIndex]
 * ```
 */
export const walletProfile = (seed: string, colorCount: number, iconCount: number): WalletProfile => {
  const colorIndex = Number.parseInt(seed.slice(0, 4), 16) % colorCount
  const iconIndex = Number.parseInt(seed.slice(4, 8), 16) % iconCount
  return {colorIndex, iconIndex}
}
