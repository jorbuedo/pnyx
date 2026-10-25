/**
 * Tiny inline trend line (no axes, no scrub) for a `{ts, value}` series — the
 * per-row price sparkline on the portfolio list. Reuses the chart geometry;
 * colour follows the first→last direction (up = success, down = error).
 *
 * @module
 */

import Svg, {Path} from 'react-native-svg'
import {useUnistyles} from 'react-native-unistyles'
import {chartDelta} from './chart-delta'
import {buildGeometry, type SeriesPoint} from './chart-geometry'

export type SparklineProps = {
  readonly series: readonly SeriesPoint[]
  readonly width?: number
  readonly height?: number
}

export const Sparkline = ({series, width = 64, height = 24}: SparklineProps) => {
  const {theme} = useUnistyles()
  if (series.length < 2) return null
  const {linePath} = buildGeometry(series, {width, height, padY: 3})
  const color = chartDelta(series).up ? theme.colors.successDefault : theme.colors.errorDefault
  return (
    <Svg width={width} height={height}>
      <Path d={linePath} stroke={color} strokeWidth={1.5} fill="none" strokeLinejoin="round" strokeLinecap="round" />
    </Svg>
  )
}
