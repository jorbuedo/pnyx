/**
 * Geometry shared by the logomark animations, in the mark's 174×175 viewBox.
 *
 * The mark has three parts, named as the design owner names them:
 * - **bowl** (or circle) — the outer arc, open at the top
 * - **seat** — the two nested arcs inside it
 * - **columns** (or dots) — the three squares in a row
 *
 * @module
 */

export const CENTER_X = 87
export const CENTER_Y = 87.5

/** The bowl and the seat, exactly as authored in assets/logo.svg. */
export const BOWL_D = 'M147.5 36.734a78.978 78.978 0 1 1-121 0'
export const SEAT_D = 'M16.045 87.5h18a52.955 52.955 0 0 0 105.91 0h-24a28.955 28.955 0 0 1-57.91 0v-6'
/**
 * The bowl's missing top, drawn left tip → right tip. Laying this over the bowl
 * completes the ring; the two share endpoints and stroke, so the join is seamless.
 */
export const BOWL_LID_D = 'M26.5 36.734A78.978 78.978 0 0 1 147.5 36.734'

export const BOWL_STROKE = 16.045
export const SEAT_STROKE = 12

export const BOWL_RADIUS = 78.978
/** The bowl's 121-unit chord over r 78.978 leaves a 100° opening at the top. */
const BOWL_GAP_DEG = 100
const DEG = Math.PI / 180

export const BOWL_LID_LENGTH = BOWL_RADIUS * BOWL_GAP_DEG * DEG
/** Arc length of SEAT_D: 18 + π·52.955 + 24 + π·28.955 + 6. */
export const SEAT_LENGTH = 305.36

export const COLUMN_SIZE = 16.334
export const COLUMN_SPACING = 25.784
/**
 * The column row sits one spacing above the mark's centre, so the bottom column
 * lands *on* the centre when the row turns vertical — Midnight's own construction
 * rule, and the row height from which a pure rotation clears a closed ring.
 */
export const COLUMN_ROW_Y = CENTER_Y - COLUMN_SPACING

/**
 * The clock's state, all of it derived from one progress value.
 *
 * `progress` counts quarter turns: 0 and 2 are the horizontal rest, 1 the
 * vertical one. Deriving every part from a single animated value is what keeps
 * them in phase — driving them off separate animations lets their cycle lengths
 * differ by a frame and walk apart over minutes.
 *
 * Every one of these returns the same value at 0 and at 2, so resetting progress
 * to loop is invisible.
 */
export const turnAngle = (progress: number) => {
  'worklet'
  return 90 * progress
}

/** 1 where the seat is fully drawn, 0 where it is withdrawn. */
export const seatFill = (progress: number) => {
  'worklet'
  return Math.abs(1 - progress)
}

/** 0 where the bowl is open, 1 where its lid has closed it into a ring. */
export const lidFill = (progress: number) => {
  'worklet'
  return 1 - Math.abs(1 - progress)
}

/**
 * One column of the row, as both its top-left corner (what `Rect` takes) and its
 * centre — the origin a rotation must turn about to stay in place.
 *
 * `index` runs 0..2, left to right.
 */
export const columnRect = (index: number) => {
  const cx = CENTER_X + COLUMN_SPACING * (index - 1)
  return {
    x: cx - COLUMN_SIZE / 2,
    y: COLUMN_ROW_Y - COLUMN_SIZE / 2,
    cx,
    cy: COLUMN_ROW_Y,
  }
}

export const COLUMNS = [columnRect(0), columnRect(1), columnRect(2)] as const

/** The row turns about the middle column's centre. */
export const COLUMN_PIVOT = COLUMNS[1]
