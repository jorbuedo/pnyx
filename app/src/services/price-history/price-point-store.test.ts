import type {PricePointRow} from '@pnyx/store/price-point-table'
import {MemoryPricePointTable} from '@pnyx/store/price-point-table.memory'
import {Effect} from 'effect'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {
  clearPricePointStore,
  clearPruneGate,
  pruneSeries,
  readSeriesRange,
  setPricePointStore,
  writeSeriesPoints,
} from './price-point-store'

const NOW = 1_700_000_000
const DAY = 86400
const NET = 'mainnet'
const KEY = 'major:ADA:USD'

const seed = (rows: PricePointRow[]) => writeSeriesPoints(rows)

describe('pruneSeries', () => {
  beforeEach(async () => {
    setPricePointStore(await Effect.runPromise(MemoryPricePointTable))
    clearPruneGate()
  })
  afterEach(() => {
    clearPricePointStore()
    clearPruneGate()
  })

  it('downsamples old 5-min points to hourly and preserves recent ones', async () => {
    const rows: PricePointRow[] = []
    // 1 day of 5-min points, 30 days ago (→ hourly after thinning).
    for (let t = NOW - 30 * DAY; t < NOW - 29 * DAY; t += 300) {
      rows.push({network: NET, seriesKey: KEY, tsBucket: t, value: 1, source: 'kraken'})
    }
    // 2 hours of recent 5-min points (→ kept in full).
    for (let t = NOW - 7200; t <= NOW; t += 300) {
      rows.push({network: NET, seriesKey: KEY, tsBucket: t, value: 2, source: 'kraken'})
    }
    await seed(rows)
    const before = await readSeriesRange(NET, KEY, 0, NOW + DAY)
    expect(before.length).toBe(rows.length)

    await pruneSeries(NET, KEY, NOW)
    const after = await readSeriesRange(NET, KEY, 0, NOW + DAY)
    // Old day → ~24 hourly; recent 2h at 5-min → ~25. Far fewer than the ~313 seeded.
    expect(after.length).toBeLessThan(before.length)
    expect(after.length).toBeLessThanOrEqual(55)
    // The most-recent point survives.
    expect(after[after.length - 1]?.tsBucket).toBe(NOW)
  })

  it('is a no-op when the series is already at retention resolution', async () => {
    await seed([{network: NET, seriesKey: KEY, tsBucket: NOW - 60, value: 9, source: 'kraken'}])
    await pruneSeries(NET, KEY, NOW)
    const after = await readSeriesRange(NET, KEY, 0, NOW + DAY)
    expect(after).toHaveLength(1)
  })

  it('runs at most once per series per session', async () => {
    for (let t = NOW - 30 * DAY; t < NOW - 29 * DAY; t += 300) {
      await seed([{network: NET, seriesKey: KEY, tsBucket: t, value: 1, source: 'kraken'}])
    }
    await pruneSeries(NET, KEY, NOW)
    const firstPass = (await readSeriesRange(NET, KEY, 0, NOW + DAY)).length
    // Re-seed dense points; a second call is gated (no re-thin this session).
    for (let t = NOW - 30 * DAY; t < NOW - 29 * DAY; t += 300) {
      await seed([{network: NET, seriesKey: KEY, tsBucket: t, value: 1, source: 'kraken'}])
    }
    await pruneSeries(NET, KEY, NOW)
    expect((await readSeriesRange(NET, KEY, 0, NOW + DAY)).length).toBeGreaterThan(firstPass)
  })
})
