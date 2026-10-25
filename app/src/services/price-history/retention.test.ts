import {describe, expect, it} from 'vitest'
import type {PricePoint} from './port'
import {retentionThin} from './retention'

const NOW = 1_700_000_000
const DAY = 86400

// A dense run of 5-min points spanning `days` back from `endSec`.
const dense = (endSec: number, days: number): PricePoint[] => {
  const out: PricePoint[] = []
  for (let t = endSec - days * DAY; t <= endSec; t += 300) out.push({ts: t, value: t})
  return out
}

describe('retentionThin', () => {
  it('keeps full 5-min resolution within 7 days', () => {
    const pts = dense(NOW, 1) // last 24h at 5-min
    expect(retentionThin(pts, NOW).length).toBe(pts.length)
  })

  it('collapses 8–90-day-old 5-min points to hourly', () => {
    // ~2 days of 5-min points centred ~30 days ago → hourly after thinning.
    const start = NOW - 31 * DAY
    const pts: PricePoint[] = []
    for (let t = start; t < start + 2 * DAY; t += 300) pts.push({ts: t, value: 1})
    const thinned = retentionThin(pts, NOW)
    // 2 days → ~48 hourly buckets (vs ~576 five-min points).
    expect(thinned.length).toBeLessThanOrEqual(50)
    expect(thinned.length).toBeGreaterThanOrEqual(46)
  })

  it('collapses >90-day-old points to daily', () => {
    const start = NOW - 200 * DAY
    const pts: PricePoint[] = []
    for (let t = start; t < start + 5 * DAY; t += 3600) pts.push({ts: t, value: 1}) // 5 days hourly
    const thinned = retentionThin(pts, NOW)
    expect(thinned.length).toBeLessThanOrEqual(6) // ~5 daily buckets
  })

  it('keeps the freshest value in each retention bucket', () => {
    const old = NOW - 200 * DAY
    const dayStart = Math.floor(old / DAY) * DAY
    const pts: PricePoint[] = [
      {ts: dayStart + 100, value: 1},
      {ts: dayStart + 200, value: 2},
      {ts: dayStart + 300, value: 3}, // latest in this day → kept
    ]
    const thinned = retentionThin(pts, NOW)
    expect(thinned).toHaveLength(1)
    expect(thinned[0]?.value).toBe(3)
  })

  it('is a fixed point on an already-thinned series', () => {
    const pts = dense(NOW, 1)
    const once = retentionThin(pts, NOW)
    expect(retentionThin(once, NOW)).toEqual(once)
  })
})
