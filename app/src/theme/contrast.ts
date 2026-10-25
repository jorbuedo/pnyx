/**
 * WCAG contrast maths, and the one decision that stops a palette shipping unreadable.
 *
 * ⚠️ **Which side of an accent is legible is a property of the accent, not a style choice.** The
 * single-palette preset could hardcode it — and did, with the reasoning in a comment: `primaryInverse`
 * is white because white on the violet `primary600` passes, while `secondaryInverse` is near-black
 * because *"white on #A29BFE is well below AA; neutral-900 on it is 7.8:1"*. Both facts are true of
 * those two hues and of nothing else.
 *
 * With a ramp per palette that hand-reasoning is the defect: any accent light enough would keep
 * white text and fail. So {@link bestInverse} measures instead, and {@link contrastRatio} lets the
 * harness assert the outcome — including the case no choice can fix, where *neither* polarity
 * reaches AA and the ramp itself has to move.
 *
 * Formulas are WCAG 2.1: relative luminance (§dfn-relative-luminance) and contrast ratio
 * (§dfn-contrast-ratio).
 *
 * @module
 */

import {parseHexToRgb} from './palette'

/** WCAG AA for normal-size text. */
export const AA_NORMAL = 4.5

/** WCAG AA for large text (>=18.66px bold or >=24px), and the floor for UI borders and glyphs. */
export const AA_LARGE = 3

/** One channel, linearised out of sRGB's transfer curve. */
const channelLuminance = (value8Bit: number): number => {
  const c = value8Bit / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/**
 * Relative luminance of an opaque sRGB hex colour, 0 (black) to 1 (white).
 *
 * ⚠️ Opaque only. An `rgba()` string has no defined luminance without the surface beneath it, so
 * callers wanting to check a translucent token must composite it first — see {@link over}.
 */
export const relativeLuminance = (hex: string): number => {
  const {r, g, b} = parseHexToRgb(hex)
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b)
}

/** Contrast ratio between two opaque hex colours, 1 (identical) to 21 (black on white). */
export const contrastRatio = (a: string, b: string): number => {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const [lighter, darker] = la >= lb ? [la, lb] : [lb, la]
  return (lighter + 0.05) / (darker + 0.05)
}

/**
 * Flatten `foreground` at `alpha` over an opaque `background`, so a translucent token can be
 * measured as the colour a viewer actually sees.
 */
export const over = (foreground: string, alpha: number, background: string): string => {
  const f = parseHexToRgb(foreground)
  const b = parseHexToRgb(background)
  const mix = (x: number, y: number): number => Math.round(x * alpha + y * (1 - alpha))
  const hex = (n: number): string => n.toString(16).padStart(2, '0')
  return `#${hex(mix(f.r, b.r))}${hex(mix(f.g, b.g))}${hex(mix(f.b, b.b))}`
}

/**
 * Any theme colour as the opaque colour a viewer sees, given what sits behind it.
 *
 * ⚠️ **Translucent tokens have no contrast ratio of their own.** `primaryMuted` in dark mode is
 * `rgba(108, 92, 231, 0.14)`; measuring it directly yields `NaN`, which a harness will happily
 * report as a pass if it only checks a threshold. Flattening first is what lets those surfaces —
 * the accent-tinted ones, where a palette is most likely to go wrong — be checked at all.
 *
 * Accepts the two forms the palette produces: `#rrggbb` and `rgba(r, g, b, a)`.
 */
export const flatten = (color: string, background: string): string => {
  const rgba = /^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([0-9.]+)\s*\)$/.exec(color)
  if (rgba === null) return color
  const [r, g, b, a] = [rgba[1], rgba[2], rgba[3], rgba[4]].map(Number) as [number, number, number, number]
  const hex = (n: number): string => n.toString(16).padStart(2, '0')
  return over(`#${hex(r)}${hex(g)}${hex(b)}`, a, background)
}

/**
 * Whichever of `candidates` reads best on `base`.
 *
 * Used for every `*Inverse` token, so "what colour is the label on this accent" is answered by the
 * accent rather than by whoever added the palette. Ties go to the earlier candidate, which makes the
 * caller's order the tie-break and keeps the result stable.
 */
export const bestInverse = (base: string, candidates: readonly [string, ...string[]]): string => {
  let best = candidates[0]
  let bestRatio = contrastRatio(base, best)
  for (const candidate of candidates.slice(1)) {
    const ratio = contrastRatio(base, candidate)
    if (ratio > bestRatio) {
      best = candidate
      bestRatio = ratio
    }
  }
  return best
}
