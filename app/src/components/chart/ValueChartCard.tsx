/**
 * Presentational value/price chart card: a big head value, a signed
 * `+X (+Y%)` delta (relative to the range start, or to the scrubbed point while
 * dragging), the {@link PriceChart}, and a {@link ChartRangePicker}. Pure UI —
 * the series + loading + currency come in as {@link ChartSeriesState}; the two
 * hook-bound wrappers ({@link PortfolioValueChart}, {@link AssetPriceChart})
 * supply them.
 *
 * @module
 */

import {useCallback, useEffect, useMemo, useState} from 'react'
import {View} from 'react-native'
import {StyleSheet, useUnistyles} from 'react-native-unistyles'
import type {ChartSeriesState} from '../../hooks/useCardanoPortfolioHistory'
import {useFormatDate} from '../../hooks/useFormatDate'
import {useFormat, useFormatPercent, useI18n} from '../../providers'
import type {ChartRange} from '../../services/price-history/range'
import {Typography} from '../Typography'
import {ChartRangePicker} from './ChartRangePicker'
import {ChartSkeleton} from './ChartSkeleton'
import {chartDelta} from './chart-delta'
import type {SeriesPoint} from './chart-geometry'
import {PriceChart} from './PriceChart'

export type ValueChartCardProps = {
  readonly state: ChartSeriesState
  readonly range: ChartRange
  readonly onRangeChange: (range: ChartRange) => void
  /** `fiatBalance` for the portfolio total, `fiatPrice` for a single asset. */
  readonly preset: 'fiatBalance' | 'fiatPrice'
  /**
   * Show the big head value at rest (and while scrubbing). On for a token's
   * price chart (the current price isn't shown elsewhere). Ignored when
   * {@link onScrubChange} is set — the parent then owns the value display.
   */
  readonly showHeadValue?: boolean
  /**
   * When set, the card renders NO head value and instead reports the scrubbed
   * point (or `null` on release) to the parent — used by the portfolio chart so
   * the balance hero above becomes the value-at-time readout while dragging.
   */
  readonly onScrubChange?: ((point: SeriesPoint | null) => void) | undefined
  readonly testID?: string
}

const CHART_HEIGHT = 168

export const ValueChartCard = ({
  state,
  range,
  onRangeChange,
  preset,
  showHeadValue = true,
  onScrubChange,
  testID,
}: ValueChartCardProps) => {
  const {series, loading, currency} = state
  const {t} = useI18n()
  const {theme} = useUnistyles()
  const format = useFormat()
  const formatPercent = useFormatPercent()
  const {formatDateTime} = useFormatDate()
  const [scrubbed, setScrubbed] = useState<SeriesPoint | null>(null)

  const delta = useMemo(() => chartDelta(series, scrubbed?.value), [series, scrubbed])
  const hasChart = !loading && series.length > 1
  // Once a range has plotted, keep the picker mounted even if another range comes
  // back empty — otherwise switching to an empty range removes the only control
  // that could switch back.
  const [everPlotted, setEverPlotted] = useState(false)
  // External mode: the parent (portfolio hero) owns the value-at-time readout.
  const external = onScrubChange !== undefined

  // Line/gradient accent tracks the delta sign — a genuinely data-driven colour
  // feeding an SVG prop, so read it from the runtime theme (sanctioned).
  const accent = delta.up ? theme.colors.successDefault : theme.colors.errorDefault

  const onScrub = useCallback((p: SeriesPoint | null) => setScrubbed(p), [])

  // Report the scrubbed point up (portfolio hero becomes the value readout).
  useEffect(() => {
    onScrubChange?.(scrubbed)
  }, [scrubbed, onScrubChange])

  useEffect(() => {
    if (hasChart) setEverPlotted(true)
  }, [hasChart])

  styles.useVariants({direction: delta.up ? 'up' : 'down'})

  const signedAbs = `${delta.abs >= 0 ? '+' : '−'}${format(Math.abs(delta.abs), {preset, currency})}`
  const signedPct = delta.pct === null ? null : formatPercent(delta.pct, {asPercent: true, fractionDigits: 2})

  // Gate on having points, not on `loading`: a range switch that keeps the old
  // series should keep showing its value, but an empty series must not render
  // chartDelta's documented head of 0 — that is a fake $0 over a skeleton.
  const showValue = !external && series.length > 0 && (showHeadValue || scrubbed !== null)

  // Nothing to plot and nothing ever plotted: render nothing at all. A zero head
  // value over an empty box and a range picker that changes nothing is worse than
  // no chart — it looks like the asset is worth zero.
  if (!loading && !hasChart && !everPlotted) return null

  return (
    <View style={styles.container} testID={testID}>
      <View style={styles.header}>
        {showValue ? (
          <Typography variant="headingLg" style={styles.headValue}>
            {format(delta.head, {preset, currency})}
          </Typography>
        ) : null}
        {hasChart ? (
          <View style={styles.deltaRow}>
            <Typography variant="bodySm_medium" style={styles.delta}>
              {signedPct === null ? signedAbs : `${signedAbs} (${signedPct})`}
            </Typography>
            {!external && scrubbed !== null ? (
              <Typography variant="bodySm_regular" style={styles.date}>
                {formatDateTime(scrubbed.ts * 1000)}
              </Typography>
            ) : null}
          </View>
        ) : null}
      </View>

      {loading ? (
        <ChartSkeleton height={CHART_HEIGHT} testID="chart-skeleton" />
      ) : hasChart ? (
        <PriceChart series={series} color={accent} height={CHART_HEIGHT} onScrub={onScrub} testID="price-chart" />
      ) : (
        <View style={[styles.empty, {height: CHART_HEIGHT}]}>
          <Typography variant="bodySm_regular" style={styles.emptyText}>
            {t('chart.unavailable')}
          </Typography>
        </View>
      )}

      <ChartRangePicker value={range} onChange={onRangeChange} testID="chart-range" />
    </View>
  )
}

const styles = StyleSheet.create((theme) => ({
  container: {gap: theme.spacing.spacing12},
  header: {gap: theme.spacing.spacing4},
  headValue: {color: theme.colors.textDefault},
  deltaRow: {flexDirection: 'row', alignItems: 'center', gap: theme.spacing.spacing8, flexWrap: 'wrap'},
  delta: {
    variants: {
      direction: {
        up: {color: theme.colors.successDefault},
        down: {color: theme.colors.errorDefault},
      },
    },
  },
  date: {color: theme.colors.textAlternative},
  empty: {alignItems: 'center', justifyContent: 'center'},
  emptyText: {color: theme.colors.textAlternative},
}))
