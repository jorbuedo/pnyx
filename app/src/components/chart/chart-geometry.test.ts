import {describe, expect, it} from 'vitest'
import {buildGeometry, nearestIndex, type SeriesPoint} from './chart-geometry'

const dims = {width: 100, height: 50, padY: 5}

const series = (...vals: number[]): SeriesPoint[] => vals.map((value, i) => ({ts: i * 60, value}))

describe('buildGeometry', () => {
  it('returns empty paths for a single point but still projects it centred', () => {
    const g = buildGeometry(series(10), dims)
    expect(g.linePath).toBe('')
    expect(g.areaPath).toBe('')
    expect(g.points).toHaveLength(1)
    expect(g.points[0]?.x).toBe(50)
    expect(g.points[0]?.y).toBe(25)
  })

  it('spreads x evenly and inverts y (higher value = smaller y)', () => {
    const g = buildGeometry(series(0, 10), dims)
    expect(g.points[0]?.x).toBe(0)
    expect(g.points[1]?.x).toBe(100)
    // value 10 (max) sits at top inset; value 0 (min) at bottom inset.
    expect(g.points[1]?.y).toBeCloseTo(5) // padY
    expect(g.points[0]?.y).toBeCloseTo(45) // height - padY
  })

  it('centres a flat series on the mid-line', () => {
    const g = buildGeometry(series(7, 7, 7), dims)
    for (const p of g.points) expect(p.y).toBe(25)
    expect(g.min).toBe(7)
    expect(g.max).toBe(7)
  })

  it('builds a line path and a closed area path to the baseline', () => {
    const g = buildGeometry(series(1, 2, 3), dims)
    expect(g.linePath.startsWith('M')).toBe(true)
    expect(g.linePath).toContain('L')
    expect(g.areaPath.endsWith('Z')).toBe(true)
    expect(g.areaPath).toContain(`L100 ${dims.height}`) // down to baseline at right
  })

  it('reports min and max', () => {
    const g = buildGeometry(series(3, 9, 1, 5), dims)
    expect(g.min).toBe(1)
    expect(g.max).toBe(9)
  })
})

describe('nearestIndex', () => {
  it('returns -1 for an empty series', () => {
    expect(nearestIndex([], 10)).toBe(-1)
  })
  it('finds the point nearest an x coordinate', () => {
    const g = buildGeometry(series(0, 1, 2, 3, 4), dims) // x at 0,25,50,75,100
    expect(nearestIndex(g.points, 0)).toBe(0)
    expect(nearestIndex(g.points, 60)).toBe(2) // 50 is nearest
    expect(nearestIndex(g.points, 99)).toBe(4)
  })
})
