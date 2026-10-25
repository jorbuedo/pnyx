import {describe, expect, it} from 'vitest'
import {buildGeometry} from './chart-geometry'
import {PLACEHOLDER_SERIES} from './chart-skeleton-series'

// The placeholder is drawn by the SAME geometry builder as the real chart, so this
// guards the silhouette against a geometry change quietly flattening it.
describe('chart skeleton placeholder series', () => {
  it('builds a line and a filled area at a realistic size', () => {
    const {linePath, areaPath, points} = buildGeometry(PLACEHOLDER_SERIES, {width: 340, height: 168})
    expect(points).toHaveLength(PLACEHOLDER_SERIES.length)
    expect(linePath.startsWith('M')).toBe(true)
    expect(areaPath.endsWith('Z')).toBe(true)
  })

  it('is not flat — a placeholder that renders as a straight line says nothing', () => {
    const {points} = buildGeometry(PLACEHOLDER_SERIES, {width: 340, height: 168})
    const ys = points.map((p) => p.y)
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(50)
  })

  it('is deterministic, so the placeholder never changes shape between renders', () => {
    const a = buildGeometry(PLACEHOLDER_SERIES, {width: 340, height: 168}).linePath
    const b = buildGeometry(PLACEHOLDER_SERIES, {width: 340, height: 168}).linePath
    expect(a).toBe(b)
  })
})
