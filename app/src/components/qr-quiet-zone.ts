/**
 * How much white a QR needs around it, and how big the symbol can be inside it.
 *
 * **The quiet zone is four modules — not a fixed number of points.** The QR spec states it in modules,
 * and a camera locks on by module, so the same 20 pt that is exactly right around a 41-module address
 * is nearly nine modules around an 89-module pairing token: padding the symbol out of the space it
 * needed. Measured on this app's own codes:
 *
 * | value | version | modules | 20 pt padding is |
 * |---|---|---|---|
 * | a Cardano address | 6 | 41 | 4.1 modules — correct |
 * | an MCP pairing URI (521 chars) | 18 | 89 | 8.9 modules — twice the spec |
 *
 * So the padding is derived from the density instead. For a fixed-size card that is `4 · edge / n`; for
 * one filling its container the two depend on each other (padding shrinks the symbol, which shrinks the
 * module, which shrinks the padding), and solving `p = 4·(W − 2p)/n` closes it as `p = 4W/(n + 8)`.
 *
 * Pure, and its own module, so the arithmetic is testable without a renderer.
 *
 * @module
 */

import QRCodeLib from 'qrcode'
import {logger} from '../logger'

const ORIGIN = 'qr-quiet-zone'

/** The spec's quiet zone, in modules per side. */
export const QUIET_ZONE_MODULES = 4

/**
 * Below this the card stops reading as a card — a hairline of white around a dense symbol looks like a
 * rendering fault even where the spec is satisfied. Only reachable for codes far denser than any we
 * generate, so it is a floor rather than a rule.
 */
const MIN_PADDING = 8

/**
 * Modules per side for a value, or `null` when it cannot be encoded.
 *
 * ⚠️ Must use the same error-correction level as {@link module:./QRCode} — a different level is a
 * different version and therefore a different module count, which would misplace every quiet zone
 * computed from it.
 */
export const moduleCountFor = (value: string, errorCorrectionLevel: 'L' | 'M' | 'Q' | 'H' = 'M'): number | null => {
  if (value === '') return null
  try {
    return QRCodeLib.create(value, {errorCorrectionLevel}).modules.size
  } catch (error) {
    // The renderer will fail on the same value and say so on screen; this only decides padding, so it
    // falls back rather than throwing — but silently guessing a density is how a quiet zone goes wrong
    // without anybody noticing.
    logger.warn('could not measure a QR’s density; padding falls back to the sparse default', {
      origin: ORIGIN,
      error: String(error),
      length: value.length,
    })
    return null
  }
}

/** Padding for a card drawing a symbol of a known edge length. */
export const quietZoneForEdge = (edge: number, moduleCount: number | null): number => {
  if (moduleCount === null || moduleCount <= 0) return DEFAULT_PADDING
  return Math.max(MIN_PADDING, Math.round((QUIET_ZONE_MODULES * edge) / moduleCount))
}

/**
 * Padding and symbol edge for a card filling `available` points.
 *
 * `p = 4W / (n + 8)` — see the module note for why it is not simply `4 · edge / n`.
 */
export const quietZoneForFill = (
  available: number,
  moduleCount: number | null,
): {readonly padding: number; readonly edge: number} => {
  if (moduleCount === null || moduleCount <= 0) {
    const padding = DEFAULT_PADDING
    return {padding, edge: Math.max(0, available - 2 * padding)}
  }
  const padding = Math.max(MIN_PADDING, Math.round((QUIET_ZONE_MODULES * available) / (moduleCount + 8)))
  return {padding, edge: Math.max(0, available - 2 * padding)}
}

/**
 * What the card used before the quiet zone was derived, and what it still uses when the density cannot
 * be measured: `theme.spacing.spacing20`'s value. Hardcoded rather than read from the theme because this
 * module is pure — the card passes nothing in, and a spacing token that moved would change a *scanning*
 * property, which is not what a spacing scale is for.
 */
const DEFAULT_PADDING = 20
