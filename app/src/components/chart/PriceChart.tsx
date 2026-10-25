/**
 * SVG area/line chart for a `{ts, value}` series with pan-to-scrub. The line and
 * gradient fill take a caller-supplied accent (the container picks up/down/brand
 * from the series delta); a vertical crosshair + dot track the finger and report
 * the touched point via `onScrub` so the header can show the value at that time.
 *
 * Gradient endpoints are read via `useUnistyles()` — the sanctioned exception
 * for runtime SVG colours (see docs/STYLING_UNISTYLES.md). Layout width comes
 * from `onLayout`; the height is fixed by the caller.
 *
 * @module
 */

import {useCallback, useEffect, useState} from 'react'
import {type LayoutChangeEvent, View} from 'react-native'
import {Gesture, GestureDetector} from 'react-native-gesture-handler'
import {runOnJS} from 'react-native-reanimated'
import Svg, {Circle, Defs, Line, LinearGradient, Path, Stop} from 'react-native-svg'
import {StyleSheet, useUnistyles} from 'react-native-unistyles'
import {buildGeometry, nearestIndex, type SeriesPoint} from './chart-geometry'

export type PriceChartProps = {
  readonly series: readonly SeriesPoint[]
  /** Accent for the line + gradient (e.g. success/error/primary). */
  readonly color: string
  readonly height?: number
  /** Reports the scrubbed point (or `null` on release) so the header can react. */
  readonly onScrub?: (point: SeriesPoint | null) => void
  readonly testID?: string
}

const GRADIENT_ID = 'price-chart-fill'

export const PriceChart = ({series, color, height = 160, onScrub, testID}: PriceChartProps) => {
  const {theme} = useUnistyles()
  const [width, setWidth] = useState(0)
  const [scrubIdx, setScrubIdx] = useState(-1)

  const onLayout = useCallback((e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width), [])

  const geometry = buildGeometry(series, {width, height})
  const {points, linePath, areaPath} = geometry
  const active = scrubIdx >= 0 && scrubIdx < points.length ? points[scrubIdx] : undefined

  // Report scrub changes to the caller (value-at-time header) — off-render.
  useEffect(() => {
    if (onScrub === undefined) return
    onScrub(active !== undefined ? {ts: active.ts, value: active.value} : null)
  }, [active, onScrub])

  const setIdxFromX = useCallback((x: number) => setScrubIdx(nearestIndex(points, x)), [points])
  const clearIdx = useCallback(() => setScrubIdx(-1), [])

  const pan = Gesture.Pan()
    .activateAfterLongPress(120)
    .onBegin((e) => runOnJS(setIdxFromX)(e.x))
    .onUpdate((e) => runOnJS(setIdxFromX)(e.x))
    .onFinalize(() => runOnJS(clearIdx)())

  return (
    <GestureDetector gesture={pan}>
      <View style={[styles.container, {height}]} onLayout={onLayout} testID={testID}>
        {width > 0 && points.length > 1 ? (
          <Svg width={width} height={height}>
            <Defs>
              <LinearGradient id={GRADIENT_ID} x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0" stopColor={color} stopOpacity={0.24} />
                <Stop offset="1" stopColor={color} stopOpacity={0} />
              </LinearGradient>
            </Defs>
            <Path d={areaPath} fill={`url(#${GRADIENT_ID})`} />
            <Path d={linePath} stroke={color} strokeWidth={2} fill="none" strokeLinejoin="round" />
            {active !== undefined ? (
              <>
                <Line
                  x1={active.x}
                  y1={0}
                  x2={active.x}
                  y2={height}
                  stroke={theme.colors.textAlternative}
                  strokeWidth={1}
                  strokeOpacity={0.5}
                />
                <Circle
                  cx={active.x}
                  cy={active.y}
                  r={5}
                  fill={color}
                  stroke={theme.colors.backgroundLayer1}
                  strokeWidth={2}
                />
              </>
            ) : null}
          </Svg>
        ) : null}
      </View>
    </GestureDetector>
  )
}

const styles = StyleSheet.create(() => ({
  container: {width: '100%'},
}))
