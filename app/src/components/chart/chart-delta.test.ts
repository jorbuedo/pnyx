import {describe, expect, it} from 'vitest'
import {chartDelta} from './chart-delta'
import type {SeriesPoint} from './chart-geometry'

const s = (...v: number[]): SeriesPoint[] => v.map((value, i) => ({ts: i, value}))

describe('chartDelta', () => {
  it('is all-zero and up for an empty series', () => {
    expect(chartDelta([])).toEqual({base: 0, head: 0, abs: 0, pct: null, up: true})
  })

  it('computes a positive delta first→last', () => {
    const d = chartDelta(s(100, 110))
    expect(d.base).toBe(100)
    expect(d.head).toBe(110)
    expect(d.abs).toBe(10)
    expect(d.pct).toBeCloseTo(10)
    expect(d.up).toBe(true)
  })

  it('computes a negative delta', () => {
    const d = chartDelta(s(100, 80))
    expect(d.abs).toBe(-20)
    expect(d.pct).toBeCloseTo(-20)
    expect(d.up).toBe(false)
  })

  it('uses the supplied head value (scrub) instead of the last point', () => {
    const d = chartDelta(s(100, 110, 130), 90)
    expect(d.head).toBe(90)
    expect(d.abs).toBe(-10)
    expect(d.up).toBe(false)
  })

  it('returns null pct when the base is 0', () => {
    const d = chartDelta(s(0, 5))
    expect(d.pct).toBeNull()
    expect(d.abs).toBe(5)
    expect(d.up).toBe(true)
  })

  it('treats a flat series as up', () => {
    expect(chartDelta(s(5, 5, 5)).up).toBe(true)
  })
})
