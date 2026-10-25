/**
 * Retention downsampling for the price-point cache. Frequently-viewed short
 * ranges keep writing fine (5-min) points that are never removed, so a series
 * grows unbounded. Retention thins by age tier — full resolution recent, hourly
 * mid-age, daily for old — so a series stays bounded while a chart at any range
 * still resolves (the step lookup finds the last point ≤ t).
 *
 * Pure: {@link retentionThin} decides the kept set; the store helper
 * (`price-point-store.pruneSeries`) applies it (rewrite). Tier boundaries are
 * the plan's defaults (5-min ≤7 d, hourly ≤90 d, daily older).
 *
 * @module
 */

import type {PricePoint} from './port'

const DAY = 86400
/** Keep full (5-min) resolution within this age. */
const FINE_MAX_AGE = 7 * DAY
/** Keep hourly resolution within this age (5-min points collapse to hourly). */
const HOURLY_MAX_AGE = 90 * DAY

/** The retention granularity (seconds) for a point of the given age. */
const granularityForAge = (ageSec: number): number => {
  if (ageSec <= FINE_MAX_AGE) return 300 // 5-min
  if (ageSec <= HOURLY_MAX_AGE) return 3600 // hourly
  return DAY // daily
}

/**
 * Downsample `points` by age tier, keeping the **last** point in each retention
 * bucket (the freshest value for that slot). Input order-independent; output
 * ascending by `ts`. A point already at (or coarser than) its tier's
 * granularity is kept as-is, so a settled series is a fixed point (no churn).
 */
export const retentionThin = (points: readonly PricePoint[], nowSec: number): PricePoint[] => {
  const kept = new Map<string, PricePoint>()
  for (const p of [...points].sort((a, b) => a.ts - b.ts)) {
    const gran = granularityForAge(nowSec - p.ts)
    const bucket = Math.floor(p.ts / gran) * gran
    // Key by (granularity, bucket) so tiers never collide at a boundary.
    kept.set(`${gran}:${bucket}`, p)
  }
  return [...kept.values()].sort((a, b) => a.ts - b.ts)
}
