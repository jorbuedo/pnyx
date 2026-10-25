/**
 * The id a Midnight holding carries in the shared asset list, and how to read it back.
 *
 * One definition, because two places depend on it agreeing: the portfolio builder writes the id, and the
 * detail screen the row navigates to has to recover the rail and token type from it. A row that builds its
 * id inline and a screen that parses it inline is exactly how a tap lands on a screen that shows nothing.
 *
 * `midnight:<tokenType>` for the transparent rail, `midnight:shielded:<tokenType>` for Zswap. The rail is in
 * the id because the two are not interchangeable — the same token type is a different holding on each.
 *
 * @module
 */

export type MidnightRail = 'unshielded' | 'shielded'

export type MidnightAssetRef = {
  readonly rail: MidnightRail
  /** Lower-case hex, as the indexer and the native summary both report it. */
  readonly tokenType: string
}

const PREFIX = 'midnight:'
const SHIELDED = 'shielded:'

export const midnightAssetId = (ref: MidnightAssetRef): string =>
  `${PREFIX}${ref.rail === 'shielded' ? SHIELDED : ''}${ref.tokenType.toLowerCase()}`

/** True for any id this module produced — used to route a tap to the Midnight detail screen. */
export const isMidnightAssetId = (id: string): boolean => id.startsWith(PREFIX)

/**
 * Read an id back. `null` for anything that is not one of ours, or whose token type is not hex — a
 * malformed id must not resolve to a plausible-looking holding of zero.
 */
export const parseMidnightAssetId = (id: string): MidnightAssetRef | null => {
  if (!isMidnightAssetId(id)) return null
  const rest = id.slice(PREFIX.length)
  const shielded = rest.startsWith(SHIELDED)
  const tokenType = (shielded ? rest.slice(SHIELDED.length) : rest).toLowerCase()
  if (!/^[0-9a-f]+$/.test(tokenType)) return null
  return {rail: shielded ? 'shielded' : 'unshielded', tokenType}
}
