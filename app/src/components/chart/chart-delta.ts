/**
 * Pure delta math for a chart header — the signed change from a series' first
 * point to its "head" (the last point, or the scrubbed point when the user is
 * dragging). Percentage is `null` when the base is 0 (no meaningful ratio),
 * never a fabricated ∞ / 100 %.
 *
 * @module
 */

import type {SeriesPoint} from './chart-geometry'

export type ChartDelta = {
  /** Series baseline (first point's value); 0 for an empty series. */
  readonly base: number
  /** The value the header shows (scrubbed, else latest); 0 for an empty series. */
  readonly head: number
  /** `head - base`. */
  readonly abs: number
  /** `abs / base` as a percent, or `null` when base is 0. */
  readonly pct: number | null
  /** True when the change is flat or positive (drives the up/down accent). */
  readonly up: boolean
}

/**
 * Delta from the series baseline to `headValue` (defaults to the last point).
 * An empty series yields an all-zero, `up` delta.
 */
export const chartDelta = (series: readonly SeriesPoint[], headValue?: number): ChartDelta => {
  const first = series[0]
  const last = series[series.length - 1]
  if (first === undefined || last === undefined) {
    return {base: 0, head: 0, abs: 0, pct: null, up: true}
  }
  const base = first.value
  const head = headValue ?? last.value
  const abs = head - base
  const pct = base !== 0 ? (abs / base) * 100 : null
  return {base, head, abs, pct, up: abs >= 0}
}
