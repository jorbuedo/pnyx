/**
 * How a token names itself on screen: the short form to lead with, and the long
 * form to add underneath — but only when the long form says something the short
 * one does not.
 *
 * Every surface used to render `label` twice (row title *and* amount suffix), so
 * a token with both a ticker and a name showed neither pairing: `MIN`/`Minswap`,
 * `WRT`/`WingRiders Governance Token`, `C4`/`Cardano Crocs Club Coin` all read as
 * just the ticker. Measured over one wallet's 88 resolved tokens: 11 carry a
 * ticker AND a different name (worth a second line), 2 have a ticker identical to
 * the name, and 71 have only a name — mostly NFTs and unlisted assets, where a
 * second line would repeat the first.
 *
 * Pure.
 *
 * @module
 */

import type {TokenInfo} from './token-metadata'

export type TokenDisplayNames = {
  /** What to lead with: the ticker when there is one, else the name. */
  readonly primary: string
  /** The fuller name, present only when it differs from `primary`. */
  readonly secondary?: string
}

const clean = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim()
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined
}

/** Case- and space-insensitive sameness, so `$CAST` / `$cast ` collapses. */
const sameText = (a: string, b: string): boolean =>
  a.replace(/\s+/g, '').toLowerCase() === b.replace(/\s+/g, '').toLowerCase()

/**
 * The display pair for a token. `primary` is always present (falling back to the
 * resolved `label`, which itself always is). `secondary` is omitted whenever it
 * would duplicate the primary — including for the many assets that only ever had
 * a name.
 */
export const tokenDisplayNames = (
  info: Pick<TokenInfo, 'label' | 'ticker' | 'name'> | undefined,
): TokenDisplayNames => {
  const ticker = clean(info?.ticker)
  const name = clean(info?.name)
  const label = clean(info?.label)
  const primary = ticker ?? name ?? label ?? ''
  if (name === undefined || sameText(name, primary)) return {primary}
  return {primary, secondary: name}
}
