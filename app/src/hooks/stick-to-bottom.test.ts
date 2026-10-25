import {describe, expect, it} from 'vitest'
import {isAtBottom, STICK_THRESHOLD} from './stick-to-bottom'

const geometry = (offsetY: number, contentHeight = 2000, viewportHeight = 800) => ({
  offsetY,
  contentHeight,
  viewportHeight,
})

describe('isAtBottom', () => {
  it('is true at the exact end', () => {
    expect(isAtBottom(geometry(1200))).toBe(true)
  })

  it('is true just short of the end, within the threshold', () => {
    // A bounce or a rounding error in the measured content height leaves a few
    // points behind; requiring zero would turn following off for nobody's benefit.
    expect(isAtBottom(geometry(1200 - STICK_THRESHOLD))).toBe(true)
  })

  it('is false once the reader has scrolled back past the threshold', () => {
    // The case the whole rule exists for: reading history must not be interrupted
    // by a message arriving on the poll.
    expect(isAtBottom(geometry(1200 - STICK_THRESHOLD - 1))).toBe(false)
  })

  it('is false at the very top of a long thread', () => {
    expect(isAtBottom(geometry(0))).toBe(false)
  })

  it('is true when the content is shorter than the viewport', () => {
    // No scroll exists, so there is no "away from the end" to be in. Returning
    // false here would switch following off before the first message arrived.
    expect(isAtBottom(geometry(0, 300, 800))).toBe(true)
  })

  it('is true past the end, which a bounce produces', () => {
    expect(isAtBottom(geometry(1250))).toBe(true)
  })

  it('honours an explicit threshold over the default', () => {
    expect(isAtBottom(geometry(1100), 0)).toBe(false)
    expect(isAtBottom(geometry(1100), 200)).toBe(true)
  })
})
