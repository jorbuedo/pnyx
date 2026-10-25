/**
 * Hook-bound chart wrappers over {@link ValueChartCard}: the aggregate portfolio
 * value chart and the single-asset (ADA / NIGHT) price chart. Each owns its
 * range state and feeds the matching price-history hook into the shared card.
 *
 * @module
 */

import {useCallback, useState} from 'react'
import {
  type ChartAsset,
  useCardanoAssetPriceHistory,
  useCardanoPortfolioHistory,
} from '../../hooks/useCardanoPortfolioHistory'
import type {PortfolioAsset} from '../../services/cardano-assets/portfolio'
import type {ChartRange} from '../../services/price-history/range'
import type {SeriesPoint} from './chart-geometry'
import {ValueChartCard} from './ValueChartCard'

/**
 * A scrubbed instant: the point the hero reads out, plus the portfolio as it stood then so the list
 * below can follow. `assets` is empty when the snapshot is not resolved yet — the caller keeps
 * showing the live list rather than blanking it.
 */
export type PortfolioScrub = {
  readonly point: SeriesPoint
  readonly assets: readonly PortfolioAsset[]
}

/**
 * Reports the scrubbed instant (or `null` on release) so the balance hero can become the
 * value-at-time readout and the asset list can show balances at that instant.
 *
 * The snapshot is resolved here rather than in the screen because this is where the history hook
 * lives: one hook instance means the rows and the line are computed from the same timeline and the
 * same price resolvers, so they cannot disagree.
 */
export const PortfolioValueChart = ({onScrubChange}: {readonly onScrubChange?: (s: PortfolioScrub | null) => void}) => {
  const [range, setRange] = useState<ChartRange>('1W')
  const state = useCardanoPortfolioHistory(range)
  const {snapshotAt} = state

  const report = useCallback(
    (point: SeriesPoint | null) => {
      if (onScrubChange === undefined) return
      onScrubChange(point === null ? null : {point, assets: snapshotAt?.(point.ts) ?? []})
    },
    [onScrubChange, snapshotAt],
  )

  return (
    <ValueChartCard
      state={state}
      range={range}
      onRangeChange={setRange}
      preset="fiatBalance"
      onScrubChange={report}
      testID="assets-chart"
    />
  )
}

export const AssetPriceChart = ({asset}: {readonly asset: ChartAsset}) => {
  const [range, setRange] = useState<ChartRange>('1W')
  const state = useCardanoAssetPriceHistory(asset, range)
  return <ValueChartCard state={state} range={range} onRangeChange={setRange} preset="fiatPrice" testID="asset-chart" />
}
