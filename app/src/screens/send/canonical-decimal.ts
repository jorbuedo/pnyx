/**
 * Exact bigint → plain decimal string (no grouping, no locale), for seeding an amount field.
 *
 * One implementation, shared by every rail's amount editor: two copies of this drifted once
 * already, and they disagreed on `decimals === 0`. Its own module because it is pure — a test
 * imports it without a React tree.
 *
 * Never for display: the output has no locale separators. It exists to hand a value to
 * `parseNumberFromText`, which owns the locale.
 *
 * @module
 */

export const canonicalToDecimal = (value: bigint, decimals: number): string => {
  if (decimals === 0) return value.toString()
  const s = value.toString().padStart(decimals + 1, '0')
  const int = s.slice(0, s.length - decimals)
  const frac = s.slice(s.length - decimals).replace(/0+$/, '')
  return frac.length > 0 ? `${int}.${frac}` : int
}
