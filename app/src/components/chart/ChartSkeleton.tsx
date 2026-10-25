/**
 * Loading placeholder for a value/price chart: the silhouette of a chart rather
 * than a filled block, so the space reads as "a chart is coming" and does not jump
 * shape when the real series arrives.
 *
 * The shape is produced by the SAME {@link buildGeometry} the real chart uses, fed
 * a fixed placeholder series — so it cannot drift from the real rendering, and it
 * is deterministic: a random walk would make the placeholder flicker to a different
 * shape on every re-render.
 *
 * It breathes on the app's existing skeleton rhythm (opacity only — cheap on older
 * Android, unlike a blur or a gradient sweep).
 *
 * @module
 */

import {useCallback, useEffect, useState} from 'react'
import {type LayoutChangeEvent, View} from 'react-native'
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated'
import Svg, {Defs, LinearGradient, Path, Stop} from 'react-native-svg'
import {StyleSheet, useUnistyles} from 'react-native-unistyles'
import {BREATHE_HALF_MS, BREATHE_HI, BREATHE_LO} from '../Loaders/Skeleton/SkeletonBase'
import {buildGeometry} from './chart-geometry'
import {PLACEHOLDER_SERIES} from './chart-skeleton-series'

const GRADIENT_ID = 'chart-skeleton-fill'

export type ChartSkeletonProps = {
  readonly height: number
  readonly testID?: string
}

export const ChartSkeleton = ({height, testID}: ChartSkeletonProps) => {
  const {theme} = useUnistyles()
  const [width, setWidth] = useState(0)
  const opacity = useSharedValue(BREATHE_LO)

  const onLayout = useCallback((e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width), [])

  useEffect(() => {
    opacity.value = withRepeat(
      withTiming(BREATHE_HI, {duration: BREATHE_HALF_MS, easing: Easing.inOut(Easing.ease)}),
      -1,
      true,
    )
    return () => {
      cancelAnimation(opacity)
    }
  }, [opacity])

  // The breathe range is tuned for a filled block; a 2px line at 6% opacity is
  // invisible, so the silhouette rides at a higher floor and breathes on top.
  const animatedStyle = useAnimatedStyle(() => ({opacity: 0.5 + opacity.value * 2.5}))

  const {linePath, areaPath, points} = buildGeometry(PLACEHOLDER_SERIES, {width, height})
  // A muted line, deliberately not the up/down accent — the direction is unknown
  // until the series loads, and colouring it would assert one.
  const tint = theme.colors.textAlternative

  return (
    <View style={[styles.container, {height}]} onLayout={onLayout} testID={testID}>
      {width > 0 && points.length > 1 ? (
        <Animated.View style={animatedStyle}>
          <Svg width={width} height={height}>
            <Defs>
              <LinearGradient id={GRADIENT_ID} x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0" stopColor={tint} stopOpacity={0.18} />
                <Stop offset="1" stopColor={tint} stopOpacity={0} />
              </LinearGradient>
            </Defs>
            <Path d={areaPath} fill={`url(#${GRADIENT_ID})`} />
            <Path d={linePath} stroke={tint} strokeWidth={2} fill="none" strokeLinejoin="round" />
          </Svg>
        </Animated.View>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create(() => ({
  container: {width: '100%'},
}))
