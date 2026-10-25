/**
 * Pure geometry for the value/price chart — maps a `{ts, value}` series into SVG
 * path strings and per-point screen coordinates. No React, no SVG runtime, so
 * the projection is unit-testable independent of the renderer.
 *
 * The y-axis is scaled to the series' own [min, max] with a small vertical inset
 * so the line never touches the top/bottom edge; a flat series centres. The
 * x-axis is spread evenly across the plot width (samples are already evenly
 * spaced in time by the range sampler).
 *
 * @module
 */

export type SeriesPoint = {readonly ts: number; readonly value: number}

export type PlotPoint = {readonly x: number; readonly y: number; readonly ts: number; readonly value: number}

export type ChartGeometry = {
  /** Line path (`M … L …`). Empty string when fewer than 2 points. */
  readonly linePath: string
  /** Closed area path (line + down to baseline + back). Empty when < 2 points. */
  readonly areaPath: string
  /** Per-sample screen coordinates, in series order. */
  readonly points: readonly PlotPoint[]
  /** Series min / max value (equal when flat). */
  readonly min: number
  readonly max: number
}

export type ChartDims = {
  readonly width: number
  readonly height: number
  /** Vertical inset (px) kept clear at top and bottom so the line never clips. */
  readonly padY?: number
}

const fmt = (n: number): string => (Number.isFinite(n) ? Number(n.toFixed(2)).toString() : '0')

/**
 * Project `series` into `dims`. Returns empty paths (but still the point list,
 * useful for a single-dot degenerate render) when the series is too short.
 */
export const buildGeometry = (series: readonly SeriesPoint[], dims: ChartDims): ChartGeometry => {
  const {width, height} = dims
  const padY = dims.padY ?? 6
  const values = series.map((p) => p.value)
  const min = values.length > 0 ? Math.min(...values) : 0
  const max = values.length > 0 ? Math.max(...values) : 0
  const span = max - min

  const plotH = Math.max(0, height - 2 * padY)
  const yFor = (value: number): number => {
    if (span <= 0) return height / 2 // flat series → centre line
    return padY + (1 - (value - min) / span) * plotH
  }
  const xFor = (i: number): number => {
    if (series.length <= 1) return width / 2
    return (i / (series.length - 1)) * width
  }

  const points: PlotPoint[] = series.map((p, i) => ({x: xFor(i), y: yFor(p.value), ts: p.ts, value: p.value}))

  if (points.length < 2) {
    return {linePath: '', areaPath: '', points, min, max}
  }

  let linePath = `M${fmt(points[0]?.x ?? 0)} ${fmt(points[0]?.y ?? 0)}`
  for (let i = 1; i < points.length; i++) {
    const p = points[i]
    if (p !== undefined) linePath += ` L${fmt(p.x)} ${fmt(p.y)}`
  }
  const first = points[0]
  const last = points[points.length - 1]
  const areaPath =
    first !== undefined && last !== undefined
      ? `${linePath} L${fmt(last.x)} ${fmt(height)} L${fmt(first.x)} ${fmt(height)} Z`
      : ''

  return {linePath, areaPath, points, min, max}
}

/** Index of the plot point whose x is nearest `px` (for scrub). `-1` if empty. */
export const nearestIndex = (points: readonly PlotPoint[], px: number): number => {
  if (points.length === 0) return -1
  let best = 0
  let bestD = Number.POSITIVE_INFINITY
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    if (p === undefined) continue
    const d = Math.abs(p.x - px)
    if (d < bestD) {
      bestD = d
      best = i
    }
  }
  return best
}
