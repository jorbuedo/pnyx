/**
 * CircleLoader component — native implementation.
 *
 * Uses Reanimated (UI thread) for smooth animation. Running on the UI thread
 * is strictly better than the old `useNativeDriver: true` path — it stays
 * responsive even when the JS thread is blocked (e.g. during WASM crypto).
 *
 * @module
 */

import {memo, useEffect} from 'react'
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated'
import {Path, Svg} from 'react-native-svg'
import {withUnistyles} from 'react-native-unistyles'
import {type CircleLoaderProps, type CircleLoaderSize, SPINNER_PATH, sizeMap} from './CircleLoader.shared'

export type {CircleLoaderSize, CircleLoaderProps}

// The spinner tint lands on the SVG `Path fill`, a raw color prop that can't
// repaint via the native shadow tree. Wrap `Path` once so `uniProps` can feed
// the default tint reactively without re-rendering in JS on a theme toggle.
const UniPath = withUnistyles(Path)

/**
 * CircleLoader component.
 *
 * A continuously spinning circular loader. The animation runs infinitely
 * until the component is unmounted.
 *
 * @example
 * ```tsx
 * <CircleLoader size="md" color="#3154CB" />
 * <CircleLoader size="lg" />
 * ```
 */
export const CircleLoader = memo(({size = 'md', color, testID}: CircleLoaderProps) => {
  const rotation = useSharedValue(0)
  const dimensions = sizeMap[size]

  useEffect(() => {
    rotation.value = withRepeat(withTiming(1, {duration: 1000, easing: Easing.linear}), -1)
    return () => cancelAnimation(rotation)
  }, [rotation])

  const animatedStyle = useAnimatedStyle(() => ({
    width: dimensions.width,
    height: dimensions.height,
    transform: [{rotate: `${rotation.value * 360}deg`}],
  }))

  return (
    <Animated.View style={animatedStyle} testID={testID}>
      <Svg width={dimensions.width} height={dimensions.height} viewBox="0 0 20 20" fill="none">
        <UniPath uniProps={(theme) => ({d: SPINNER_PATH, fill: color ?? theme.colors.primaryDefault})} />
      </Svg>
    </Animated.View>
  )
})
