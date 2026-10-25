/**
 * The fixed series behind the chart loading placeholder.
 *
 * Its own module because the placeholder is drawn by the real
 * {@link buildGeometry}, and this shape is worth testing without pulling
 * Reanimated / SVG / Unistyles into the test.
 *
 * Deterministic on purpose: a random walk would make the placeholder flicker to a
 * different shape on every re-render.
 *
 * @module
 */

import type {SeriesPoint} from './chart-geometry'

/**
 * A neutral, generically chart-shaped series: a couple of rises and dips, ending
 * mid-range so it suggests neither a gain nor a loss before the data says which.
 * Values are unitless — only their shape is rendered.
 */
export const PLACEHOLDER_SERIES: readonly SeriesPoint[] = [
  38, 42, 40, 47, 52, 49, 56, 61, 58, 54, 60, 66, 63, 69, 74, 71, 66, 70, 76, 73,
].map((value, index) => ({ts: index, value}))
