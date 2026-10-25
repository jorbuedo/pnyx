import {describe, expect, it} from 'vitest'

import {
  BOWL_D,
  BOWL_LID_D,
  BOWL_LID_LENGTH,
  BOWL_RADIUS,
  BOWL_STROKE,
  CENTER_X,
  CENTER_Y,
  COLUMN_ROW_Y,
  COLUMN_SIZE,
  COLUMN_SPACING,
  COLUMNS,
  columnRect,
  lidFill,
  seatFill,
  turnAngle,
} from './geometry'

/**
 * The Midnight mark as authored in assets/icons/NightDark.svg, in its own
 * 69-unit viewBox. Scaled onto ours, the two marks draw the same three dots at
 * the same size and spacing — the relationship the logomark animations play on,
 * so it is asserted rather than assumed.
 */
const MIDNIGHT = {
  centerY: 34.086,
  outerRadius: 34.086,
  innerRadius: 27.8,
  dotSize: 6.4,
  dotTopYs: [10.684, 20.783, 30.887],
} as const

/** Ring centreline radius ↦ bowl radius is what sets the scale between the marks. */
const midnightToPnyx = 78.978 / ((MIDNIGHT.outerRadius + MIDNIGHT.innerRadius) / 2)

/** A y in Midnight's 69-unit box, expressed in our 174-unit box. */
const inOurSpace = (y: number) => (y - MIDNIGHT.centerY) * midnightToPnyx + CENTER_Y

describe('midnight and pnyx draw the same three dots', () => {
  it('scales the dot onto the column', () => {
    expect(MIDNIGHT.dotSize * midnightToPnyx).toBeCloseTo(COLUMN_SIZE, 2)
  })

  it('scales the dot spacing onto the column spacing', () => {
    // Centres differ from tops by a constant, so it cancels in the spacing.
    const spacing = (MIDNIGHT.dotTopYs[2] - MIDNIGHT.dotTopYs[0]) / 2
    expect(spacing * midnightToPnyx).toBeCloseTo(COLUMN_SPACING, 2)
  })

  it('scales the ring thickness onto the bowl stroke', () => {
    const thickness = MIDNIGHT.outerRadius - MIDNIGHT.innerRadius
    expect(thickness * midnightToPnyx).toBeCloseTo(BOWL_STROKE, 2)
  })
})

describe('every part of the clock reads off one progress value', () => {
  it('rests on the complete Pnyx mark at both ends of a cycle', () => {
    for (const progress of [0, 2]) {
      expect(turnAngle(progress) % 180).toBeCloseTo(0, 6)
      expect(seatFill(progress)).toBeCloseTo(1, 6)
      expect(lidFill(progress)).toBeCloseTo(0, 6)
    }
  })

  it('rests on Midnight’s form at the half-cycle', () => {
    expect(turnAngle(1)).toBeCloseTo(90, 6)
    expect(seatFill(1)).toBeCloseTo(0, 6)
    expect(lidFill(1)).toBeCloseTo(1, 6)
  })

  /**
   * The whole point of deriving from one value: the reset that loops the cycle
   * must land on a frame indistinguishable from the one it started on, or the
   * loop visibly jumps.
   */
  it('leaves every part identical at progress 0 and 2, so the reset is invisible', () => {
    expect(seatFill(0)).toBe(seatFill(2))
    expect(lidFill(0)).toBe(lidFill(2))
    expect(turnAngle(2) - turnAngle(0)).toBe(180)
  })

  it('moves the seat and the lid in exact opposition', () => {
    for (const progress of [0, 0.25, 0.5, 1, 1.5, 2]) {
      expect(seatFill(progress) + lidFill(progress)).toBeCloseTo(1, 6)
    }
  })
})

describe('the turned stack lands on midnight without translating', () => {
  it('puts the column row exactly on midnight’s trio centre', () => {
    expect(COLUMN_ROW_Y).toBeCloseTo(inOurSpace(MIDNIGHT.dotTopYs[1] + MIDNIGHT.dotSize / 2), 1)
  })

  /**
   * The reason the mark's row sits where it does: a pure rotation has to leave the
   * top column clear of the closed ring, and only this row height does that.
   */
  it('clears the closed ring by the same margin midnight does', () => {
    const ringInnerEdgeY = CENTER_Y - (BOWL_RADIUS - BOWL_STROKE / 2)
    const topColumnEdgeY = COLUMN_ROW_Y - COLUMN_SPACING - COLUMN_SIZE / 2
    const midnightClearance = (MIDNIGHT.dotTopYs[0] - (MIDNIGHT.centerY - MIDNIGHT.innerRadius)) * midnightToPnyx

    expect(topColumnEdgeY - ringInnerEdgeY).toBeGreaterThan(0)
    expect(topColumnEdgeY - ringInnerEdgeY).toBeCloseTo(midnightClearance, 1)
  })

  it('would not clear it from any higher row', () => {
    const ringInnerEdgeY = CENTER_Y - (BOWL_RADIUS - BOWL_STROKE / 2)
    const midnightClearance = (MIDNIGHT.dotTopYs[0] - (MIDNIGHT.centerY - MIDNIGHT.innerRadius)) * midnightToPnyx
    const higherRow = COLUMN_ROW_Y - 1
    expect(higherRow - COLUMN_SPACING - COLUMN_SIZE / 2 - ringInnerEdgeY).toBeLessThan(midnightClearance)
  })
})

describe('the bowl lid completes the bowl into a ring', () => {
  it('starts at the bowl left tip and ends at its right tip', () => {
    // BOWL_D is authored right tip → left tip; the lid runs the other way, left → right.
    expect(BOWL_D).toContain('M147.5 36.734')
    expect(BOWL_D).toContain('-121 0')
    expect(BOWL_LID_D.startsWith('M26.5 36.734')).toBe(true)
    expect(BOWL_LID_D.endsWith('147.5 36.734')).toBe(true)
  })

  it('takes the short way over the top, not back round the bowl', () => {
    // large-arc 0, sweep 1: the 100° arc clockwise from the left tip.
    expect(BOWL_LID_D).toContain(`A${BOWL_RADIUS} ${BOWL_RADIUS} 0 0 1`)
  })

  /**
   * Ties the lid's length back to the authored bowl rather than to a second
   * hardcoded number: BOWL_D's own 121-unit chord at r 78.978 is what fixes how
   * much arc is missing.
   */
  it('spans exactly the arc the authored chord leaves open', () => {
    const AUTHORED_CHORD = 121
    const gapRadians = 2 * Math.asin(AUTHORED_CHORD / 2 / BOWL_RADIUS)
    expect(BOWL_LID_LENGTH).toBeCloseTo(BOWL_RADIUS * gapRadians, 2)
  })
})

describe('columnRect', () => {
  it('reproduces the three squares of assets/logo.svg', () => {
    // Authored: 16.334 squares at x 53.049 / 78.833 / 104.617, y 53.549.
    expect(COLUMNS.map(({x, y}) => ({x, y}))).toEqual([
      {x: expect.closeTo(53.049, 2), y: expect.closeTo(53.549, 2)},
      {x: expect.closeTo(78.833, 2), y: expect.closeTo(53.549, 2)},
      {x: expect.closeTo(104.617, 2), y: expect.closeTo(53.549, 2)},
    ])
  })

  it('reports the centre a column must rotate about to stay in place', () => {
    for (const column of COLUMNS) {
      expect(column.cx).toBeCloseTo(column.x + COLUMN_SIZE / 2, 6)
      expect(column.cy).toBeCloseTo(column.y + COLUMN_SIZE / 2, 6)
    }
  })

  it('centres the middle column on the mark axis at the row height', () => {
    expect(columnRect(1).cx).toBeCloseTo(CENTER_X, 6)
    expect(columnRect(1).cy).toBeCloseTo(COLUMN_ROW_Y, 6)
  })
})
