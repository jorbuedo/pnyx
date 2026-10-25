import {describe, expect, it} from 'vitest'
import {PAINT_BUDGET_BYTES, paintFitsBudget} from './paint-budget'

// The device the crash was reproduced on: 1080x2424 at pixelRatio 3.
const RATIO = 3
const CARD_WIDTH_POINTS = 328

describe('chamfer paint budget', () => {
  it('passes an ordinary card', () => {
    expect(paintFitsBudget(CARD_WIDTH_POINTS, 200, RATIO)).toBe(true)
  })

  it('refuses the metadata card that killed the process', () => {
    // 918 lines of pretty-printed JSON came out at roughly 19,600pt tall, which
    // react-native-svg asked Android for as a 231MB bitmap.
    expect(paintFitsBudget(CARD_WIDTH_POINTS, 19_600, RATIO)).toBe(false)
  })

  it('stays under Android’s ~100MB canvas cap at the limit it does allow', () => {
    const tallestAllowed = PAINT_BUDGET_BYTES / (CARD_WIDTH_POINTS * RATIO * RATIO * 4)

    expect(paintFitsBudget(CARD_WIDTH_POINTS, tallestAllowed, RATIO)).toBe(true)
    expect(CARD_WIDTH_POINTS * RATIO * tallestAllowed * RATIO * 4).toBeLessThan(100 * 1024 * 1024)
  })

  it('scales with the pixel ratio, not the point size alone', () => {
    // The same box is four times the bitmap at 3x that it is at 1.5x.
    expect(paintFitsBudget(CARD_WIDTH_POINTS, 8_000, 1.5)).toBe(true)
    expect(paintFitsBudget(CARD_WIDTH_POINTS, 8_000, 3)).toBe(false)
  })

  it('allows a zero-sized box, which is what an unmeasured layout reports', () => {
    expect(paintFitsBudget(0, 0, RATIO)).toBe(true)
  })
})
