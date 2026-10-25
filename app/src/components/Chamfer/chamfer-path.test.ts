import {describe, expect, it} from 'vitest'

import {chamferBracketPaths, chamferPath, chamferSizeForHeight, clampCorners, cornersForCut} from './chamfer-path'

describe('chamferSizeForHeight', () => {
  it('lands on the chosen 10pt cut for a standard button', () => {
    expect(chamferSizeForHeight(48)).toBe(10)
  })

  it('shrinks the cut on a pill so it is not chewed away', () => {
    expect(chamferSizeForHeight(28)).toBe(6)
  })

  it('caps the cut so a tall card does not get a huge bevel', () => {
    expect(chamferSizeForHeight(400)).toBe(12)
  })

  it('holds a floor so a very short row still reads as chamfered', () => {
    expect(chamferSizeForHeight(8)).toBe(4)
  })

  it('returns zero for an unmeasured box rather than the floor', () => {
    expect(chamferSizeForHeight(0)).toBe(0)
  })
})

describe('cornersForCut', () => {
  it('cuts only top-right and bottom-left for the diagonal preset', () => {
    expect(cornersForCut('diagonal', 12)).toEqual({topLeft: 0, topRight: 12, bottomRight: 0, bottomLeft: 12})
  })

  it('mirrors the diagonal onto the other axis', () => {
    expect(cornersForCut('diagonalReverse', 12)).toEqual({topLeft: 12, topRight: 0, bottomRight: 12, bottomLeft: 0})
  })

  it('leaves every corner sharp for none', () => {
    expect(cornersForCut('none', 12)).toEqual({topLeft: 0, topRight: 0, bottomRight: 0, bottomLeft: 0})
  })

  // A stack of rows carries one grouped card between them, so the two halves of the
  // diagonal have to compose back into it: first row `topRight`, last `bottomLeft`,
  // middles sharp. Without the pair, a grouped list either cut both top corners
  // (`top`) or double-painted its single-row case.
  it('splits the diagonal into halves that recompose it', () => {
    const first = cornersForCut('topRight', 12)
    const last = cornersForCut('bottomLeft', 12)
    expect(first).toEqual({topLeft: 0, topRight: 12, bottomRight: 0, bottomLeft: 0})
    expect(last).toEqual({topLeft: 0, topRight: 0, bottomRight: 0, bottomLeft: 12})
    expect({
      topLeft: first.topLeft + last.topLeft,
      topRight: first.topRight + last.topRight,
      bottomRight: first.bottomRight + last.bottomRight,
      bottomLeft: first.bottomLeft + last.bottomLeft,
    }).toEqual(cornersForCut('diagonal', 12))
  })
})

describe('clampCorners', () => {
  it('leaves cuts that fit untouched', () => {
    const corners = {topLeft: 0, topRight: 10, bottomRight: 0, bottomLeft: 10}

    expect(clampCorners(corners, 200, 48)).toEqual(corners)
  })

  it('splits an edge two oversized cuts share, so the path cannot fold back on itself', () => {
    const corners = {topLeft: 40, topRight: 40, bottomRight: 40, bottomLeft: 40}

    expect(clampCorners(corners, 200, 24)).toEqual({topLeft: 12, topRight: 12, bottomRight: 12, bottomLeft: 12})
  })

  it('allows one corner to be cut by the full height, which is what makes a slash', () => {
    const corners = {topLeft: 0, topRight: 24, bottomRight: 0, bottomLeft: 0}

    expect(clampCorners(corners, 200, 24)).toEqual(corners)
  })

  it('caps each cut to the box first, then splits the shared edge in proportion', () => {
    // topRight is capped 30 -> 20 (the height) before the right edge is divided,
    // so the two end up sharing that 20 as 2:1 rather than 3:1.
    const clamped = clampCorners({topLeft: 0, topRight: 30, bottomRight: 10, bottomLeft: 0}, 200, 20)

    expect(clamped.topRight).toBeCloseTo(13.33, 1)
    expect(clamped.bottomRight).toBeCloseTo(6.67, 1)
    expect(clamped.topRight + clamped.bottomRight).toBeCloseTo(20)
  })

  it('fits opposite corners too, which share no edge but collide across the diagonal', () => {
    // Two full-height cuts on a square consumed the whole shape and rendered as
    // nothing — the path collapsed to two points.
    const clamped = clampCorners({topLeft: 0, topRight: 48, bottomRight: 0, bottomLeft: 48}, 48, 48)

    expect(clamped.topRight).toBe(24)
    expect(clamped.bottomLeft).toBe(24)
  })

  it('leaves a lone full-height cut alone, since nothing opposes it', () => {
    const clamped = clampCorners({topLeft: 0, topRight: 20, bottomRight: 0, bottomLeft: 0}, 100, 20)

    expect(clamped.topRight).toBe(20)
  })

  it('never returns a negative cut', () => {
    expect(clampCorners({topLeft: -5, topRight: 0, bottomRight: 0, bottomLeft: 0}, 100, 100).topLeft).toBe(0)
  })
})

describe('chamferPath', () => {
  it('walks the eight vertices of a diagonal chamfer clockwise from the top-left', () => {
    const d = chamferPath({width: 100, height: 40, size: 10, cut: 'diagonal'})

    expect(d).toBe('M0 0 L90 0 L100 10 L100 40 L100 40 L10 40 L0 30 L0 0 Z')
  })

  it('degenerates to a plain rectangle when nothing is cut', () => {
    const d = chamferPath({width: 100, height: 40, size: 10, cut: 'none'})

    expect(d).toBe('M0 0 L100 0 L100 0 L100 40 L100 40 L0 40 L0 40 L0 0 Z')
  })

  it('insets every edge so a stroke lands inside the layout box', () => {
    const d = chamferPath({width: 100, height: 40, size: 10, cut: 'all', inset: 1})

    expect(d).toBe('M11 1 L89 1 L99 11 L99 29 L89 39 L11 39 L1 29 L1 11 Z')
  })

  it('returns an empty path for an unmeasured box', () => {
    expect(chamferPath({width: 0, height: 0, size: 10, cut: 'diagonal'})).toBe('')
  })

  it('returns an empty path when the inset consumes the whole box', () => {
    expect(chamferPath({width: 4, height: 4, size: 2, cut: 'all', inset: 2})).toBe('')
  })

  it('clamps an oversized cut rather than producing a self-intersecting path', () => {
    const d = chamferPath({width: 40, height: 40, size: 999, cut: 'all'})

    expect(d).toBe('M20 0 L20 0 L40 20 L40 20 L20 40 L20 40 L0 20 L0 20 Z')
  })
})

describe('single-corner cuts', () => {
  it('cuts only the top-right corner, leaving the other three sharp', () => {
    expect(cornersForCut('topRight', 12)).toEqual({topLeft: 0, topRight: 12, bottomRight: 0, bottomLeft: 0})
  })

  it('shapes only the leading edge of the box', () => {
    const d = chamferPath({width: 60, height: 40, size: 12, cut: 'topRight'})

    expect(d).toBe('M0 0 L48 0 L60 12 L60 40 L60 40 L0 40 L0 40 L0 0 Z')
  })

  it('sizes from the caller, unlike slashEnd which measures the box', () => {
    const small = chamferPath({width: 60, height: 40, size: 6, cut: 'topRight'})
    const large = chamferPath({width: 60, height: 40, size: 12, cut: 'topRight'})

    expect(small).not.toBe(large)
  })
})

describe('slashEnd', () => {
  it('turns the trailing edge into a single full-height diagonal', () => {
    const d = chamferPath({width: 100, height: 20, size: 0, cut: 'slashEnd'})

    expect(d).toBe('M0 0 L80 0 L100 20 L100 20 L100 20 L0 20 L0 20 L0 0 Z')
  })

  it('ignores the caller size, measuring its cut off the box instead', () => {
    const a = chamferPath({width: 100, height: 20, size: 0, cut: 'slashEnd'})
    const b = chamferPath({width: 100, height: 20, size: 999, cut: 'slashEnd'})

    expect(a).toBe(b)
  })

  it('cuts nothing else, so the other three corners stay sharp', () => {
    const {topLeft, bottomRight, bottomLeft} = clampCorners(cornersForCut('slashEnd', 20), 100, 20)

    expect([topLeft, bottomRight, bottomLeft]).toEqual([0, 0, 0])
  })
})

describe('chamferBracketPaths', () => {
  it('emits one open path per cut corner', () => {
    expect(chamferBracketPaths({width: 100, height: 40, size: 10, cut: 'diagonal', armLength: 8})).toHaveLength(2)
    expect(chamferBracketPaths({width: 100, height: 40, size: 10, cut: 'all', armLength: 8})).toHaveLength(4)
  })

  it('emits nothing when no corner is cut', () => {
    expect(chamferBracketPaths({width: 100, height: 40, size: 10, cut: 'none', armLength: 8})).toEqual([])
  })

  it('traces the top-right bracket across the cut and down the right edge', () => {
    const [topRight] = chamferBracketPaths({width: 100, height: 40, size: 10, cut: 'diagonal', armLength: 8})

    expect(topRight).toBe('M82 0 L90 0 L100 10 L100 18')
  })

  it('caps the arm so it cannot exceed half the box', () => {
    const [topRight] = chamferBracketPaths({width: 40, height: 20, size: 4, cut: 'diagonal', armLength: 999})

    expect(topRight).toBe('M26 0 L36 0 L40 4 L40 14')
  })

  it('returns nothing for an unmeasured box', () => {
    expect(chamferBracketPaths({width: 0, height: 0, size: 10, cut: 'all', armLength: 8})).toEqual([])
  })
})
