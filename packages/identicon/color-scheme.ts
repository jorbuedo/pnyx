/**
 * Color schemes for Blockies identicon generation.
 *
 * 5 curated palettes that produce visually distinct wallet identicons.
 *
 * @module
 */

export type ColorScheme = {
  readonly primary: string
  readonly secondary: string
  readonly spots: string
}

const mkcolor = (primary: string, secondary: string, spots: string): ColorScheme =>
  Object.freeze({primary, secondary, spots})

export const colorScheme: readonly ColorScheme[] = Object.freeze([
  mkcolor('#E1F2FF', '#17D1AA', '#A80B32'),
  mkcolor('#E1F2FF', '#FA5380', '#0833B2'),
  mkcolor('#E1F2FF', '#F06EF5', '#0804F7'),
  mkcolor('#E1F2FF', '#EBB687', '#852D62'),
  mkcolor('#E1F2FF', '#F59F9A', '#085F48'),
])
