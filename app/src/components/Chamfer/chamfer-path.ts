/**
 * Chamfer geometry — pure SVG path construction for bevelled (cut) corners.
 *
 * React Native has no `clip-path` and no `corner-shape`, so a chamfered surface is
 * drawn as an SVG path sitting behind the content rather than as a border style.
 * This module owns the geometry so it can be unit-tested without a renderer.
 *
 * @module
 */

/** Per-corner cut length in points. `0` leaves the corner sharp. */
export type ChamferCorners = {
  readonly topLeft: number
  readonly topRight: number
  readonly bottomRight: number
  readonly bottomLeft: number
}

/**
 * Which corners a preset cuts.
 *
 * `slashEnd` is the odd one out: it cuts the top-right corner by the box's full
 * height, turning the trailing edge into a single 45° slash rather than nicking
 * the corner. Its cut is driven by the measured height, so `size` is ignored.
 */
export type ChamferCut =
  | 'diagonal'
  | 'diagonalReverse'
  | 'all'
  | 'top'
  | 'bottom'
  | 'topRight'
  | 'bottomLeft'
  | 'slashEnd'
  | 'none'

export type ChamferPathInput = {
  readonly width: number
  readonly height: number
  /** Cut length applied to the corners selected by `cut`, before clamping. */
  readonly size: number
  readonly cut: ChamferCut
  /**
   * Pulls the path inwards on every side. A stroked path passes its full stroke
   * width, not half: centred on the boundary, the stroke's outer half lands on the
   * SVG viewport edge, where the rasteriser drops it unevenly.
   */
  readonly inset?: number
}

const CUT_CORNERS: Record<ChamferCut, ChamferCorners> = {
  // The house style: top-right and bottom-left, giving diagonal symmetry.
  diagonal: {topLeft: 0, topRight: 1, bottomRight: 0, bottomLeft: 1},
  diagonalReverse: {topLeft: 1, topRight: 0, bottomRight: 1, bottomLeft: 0},
  all: {topLeft: 1, topRight: 1, bottomRight: 1, bottomLeft: 1},
  top: {topLeft: 1, topRight: 1, bottomRight: 0, bottomLeft: 0},
  bottom: {topLeft: 0, topRight: 0, bottomRight: 1, bottomLeft: 1},
  // A single cut corner, for a surface that is revealed from one side and only
  // needs the leading edge shaped.
  topRight: {topLeft: 0, topRight: 1, bottomRight: 0, bottomLeft: 0},
  // The other half of the house diagonal, so a stack of rows can carry one grouped
  // card between them: the first row cuts `topRight`, the last `bottomLeft`.
  bottomLeft: {topLeft: 0, topRight: 0, bottomRight: 0, bottomLeft: 1},
  slashEnd: {topLeft: 0, topRight: 1, bottomRight: 0, bottomLeft: 0},
  none: {topLeft: 0, topRight: 0, bottomRight: 0, bottomLeft: 0},
}

/**
 * Scales a cut to the box it sits on, so a 28pt pill and a 48pt button read as the
 * same treatment instead of the pill being chewed away by a button-sized bevel.
 */
export const chamferSizeForHeight = (
  height: number,
  {ratio = 0.21, min = 4, max = 12}: {ratio?: number; min?: number; max?: number} = {},
): number => {
  if (!(height > 0)) return 0

  return Math.max(min, Math.min(max, Math.round(height * ratio)))
}

/** Resolves a cut preset and a size into per-corner lengths. */
export const cornersForCut = (cut: ChamferCut, size: number): ChamferCorners => {
  const mask = CUT_CORNERS[cut]

  return {
    topLeft: mask.topLeft * size,
    topRight: mask.topRight * size,
    bottomRight: mask.bottomRight * size,
    bottomLeft: mask.bottomLeft * size,
  }
}

/**
 * Clamps cuts so adjacent ones never overrun the edge they share, which would
 * fold the path back on itself and render as a bowtie.
 *
 * The limit is per edge, not a blanket half-of-the-shorter-side: a single corner
 * may legitimately be cut by the box's full height (that is what turns a trailing
 * edge into a slash), and only becomes invalid once the corner it shares an edge
 * with also wants room. Two cuts competing for one edge are scaled down in proportion.
 *
 * Opposite corners share no edge but still collide across the diagonal — two
 * full-height cuts on a square consume the whole shape and leave a path that
 * renders as nothing — so each diagonal pair is fitted to the box as well.
 */
export const clampCorners = (corners: ChamferCorners, width: number, height: number): ChamferCorners => {
  const limit = Math.max(0, Math.min(width, height))
  const clamp = (value: number) => Math.max(0, Math.min(value, limit))

  let topLeft = clamp(corners.topLeft)
  let topRight = clamp(corners.topRight)
  let bottomRight = clamp(corners.bottomRight)
  let bottomLeft = clamp(corners.bottomLeft)

  const fitEdge = (a: number, b: number, edge: number): readonly [number, number] => {
    const total = a + b
    return total > edge && total > 0 ? [(a * edge) / total, (b * edge) / total] : [a, b]
  }

  ;[topLeft, topRight] = fitEdge(topLeft, topRight, width)
  ;[bottomLeft, bottomRight] = fitEdge(bottomLeft, bottomRight, width)
  ;[topLeft, bottomLeft] = fitEdge(topLeft, bottomLeft, height)
  ;[topRight, bottomRight] = fitEdge(topRight, bottomRight, height)
  ;[topLeft, bottomRight] = fitEdge(topLeft, bottomRight, limit)
  ;[topRight, bottomLeft] = fitEdge(topRight, bottomLeft, limit)

  return {topLeft, topRight, bottomRight, bottomLeft}
}

/**
 * Builds a closed SVG path for a chamfered rectangle, walking clockwise from the
 * top-left corner. Returns an empty string for a degenerate box so callers can
 * skip rendering before their first layout pass.
 */
export const chamferPath = ({width, height, size, cut, inset = 0}: ChamferPathInput): string => {
  const innerWidth = width - inset * 2
  const innerHeight = height - inset * 2

  if (!(innerWidth > 0 && innerHeight > 0)) return ''

  // `slashEnd` measures its cut off the box rather than the caller's `size`.
  const requested = cut === 'slashEnd' ? cornersForCut(cut, innerHeight) : cornersForCut(cut, size)
  const {topLeft, topRight, bottomRight, bottomLeft} = clampCorners(requested, innerWidth, innerHeight)

  const left = inset
  const top = inset
  const right = inset + innerWidth
  const bottom = inset + innerHeight

  const round = (n: number) => Math.round(n * 100) / 100

  const points: ReadonlyArray<readonly [number, number]> = [
    [left + topLeft, top],
    [right - topRight, top],
    [right, top + topRight],
    [right, bottom - bottomRight],
    [right - bottomRight, bottom],
    [left + bottomLeft, bottom],
    [left, bottom - bottomLeft],
    [left, top + topLeft],
  ]

  const [start, ...rest] = points

  if (!start) return ''

  const body = rest.map(([x, y]) => `L${round(x)} ${round(y)}`).join(' ')

  return `M${round(start[0])} ${round(start[1])} ${body} Z`
}

/**
 * Builds the two corner brackets of a HUD-style frame: short strokes tracing only
 * the cut corners. Rendered as open paths, so they carry no fill.
 */
export const chamferBracketPaths = ({
  width,
  height,
  size,
  cut,
  inset = 0,
  armLength,
}: ChamferPathInput & {readonly armLength: number}): readonly string[] => {
  const innerWidth = width - inset * 2
  const innerHeight = height - inset * 2

  if (!(innerWidth > 0 && innerHeight > 0)) return []

  const corners = clampCorners(cornersForCut(cut, size), innerWidth, innerHeight)
  const arm = Math.max(0, Math.min(armLength, innerWidth / 2, innerHeight / 2))

  const left = inset
  const top = inset
  const right = inset + innerWidth
  const bottom = inset + innerHeight

  const round = (n: number) => Math.round(n * 100) / 100
  const line = (pts: ReadonlyArray<readonly [number, number]>) =>
    pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${round(x)} ${round(y)}`).join(' ')

  const paths: string[] = []

  if (corners.topRight > 0) {
    paths.push(
      line([
        [right - corners.topRight - arm, top],
        [right - corners.topRight, top],
        [right, top + corners.topRight],
        [right, top + corners.topRight + arm],
      ]),
    )
  }

  if (corners.bottomLeft > 0) {
    paths.push(
      line([
        [left + corners.bottomLeft + arm, bottom],
        [left + corners.bottomLeft, bottom],
        [left, bottom - corners.bottomLeft],
        [left, bottom - corners.bottomLeft - arm],
      ]),
    )
  }

  if (corners.topLeft > 0) {
    paths.push(
      line([
        [left + corners.topLeft + arm, top],
        [left + corners.topLeft, top],
        [left, top + corners.topLeft],
        [left, top + corners.topLeft + arm],
      ]),
    )
  }

  if (corners.bottomRight > 0) {
    paths.push(
      line([
        [right - corners.bottomRight - arm, bottom],
        [right - corners.bottomRight, bottom],
        [right, bottom - corners.bottomRight],
        [right, bottom - corners.bottomRight - arm],
      ]),
    )
  }

  return paths
}
