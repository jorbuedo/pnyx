/**
 * SkeletonBase component.
 *
 * Renders a breathing-pulse placeholder while content is loading.
 * Opacity oscillates between 6 % and 14 % over 1.8 s (two 900 ms half-periods),
 * matching the Pnyx design-system spec.
 *
 * @module
 */

import {memo, type ReactNode, useEffect} from 'react'
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated'
import {StyleSheet} from 'react-native-unistyles'

// Full cycle = 2 × BREATHE_HALF_MS = 1.8 s breathe cycle. Exported so any
// non-rectangular placeholder (the chart silhouette) breathes to the same rhythm
// instead of inventing a second one.
export const BREATHE_HALF_MS = 900

export const BREATHE_LO = 0.06
export const BREATHE_HI = 0.14

export type SkeletonBaseProps = {
  /** Child content to show when not loading */
  children?: ReactNode
  /** Whether to show the skeleton animation */
  show: boolean
  /**
   * The radius the placeholder would have had. Only its ratio to the box is read
   * now, to tell a circular placeholder from a rectangular one — a rectangle
   * renders sharp either way.
   */
  radius: number
  /** Width of the skeleton in pixels */
  width: number
  /** Height of the skeleton in pixels */
  height: number
  /** Test ID for e2e testing */
  testID?: string | undefined
}

/**
 * SkeletonBase — breathing-pulse loading placeholder.
 *
 * When `show` is true, renders an animated foreground-tinted rectangle that
 * pulses between 6 % and 14 % opacity. When `show` is false, renders children.
 *
 * @internal Use Skeleton or SkeletonSquare for most cases.
 */
export const SkeletonBase = memo(({children, show, width, height, radius, testID}: SkeletonBaseProps) => {
  const opacity = useSharedValue(BREATHE_LO)

  useEffect(() => {
    if (!show) {
      cancelAnimation(opacity)
      opacity.value = BREATHE_LO
      return
    }
    opacity.value = withRepeat(
      withTiming(BREATHE_HI, {duration: BREATHE_HALF_MS, easing: Easing.inOut(Easing.ease)}),
      -1,
      true,
    )
    return () => {
      cancelAnimation(opacity)
    }
  }, [show, opacity])

  const animatedStyle = useAnimatedStyle(() => ({opacity: opacity.value}))

  if (!show) return <>{children}</>

  // A placeholder stands in for the shape it replaces, so a circle-radius one
  // stays a circle. Every other placeholder is a sharp rectangle: a skeleton is
  // the densest surface on screen at the moment the JS thread is busiest, and it
  // is not worth a paint layer per row to shape a corner nobody reads.
  const isCircle = radius * 2 >= Math.min(width, height)

  return (
    <Animated.View
      testID={testID}
      style={[styles.block, {width, height}, isCircle && {borderRadius: radius}, animatedStyle]}
    />
  )
})

const styles = StyleSheet.create(({colors}) => ({
  block: {
    backgroundColor: colors.textDefault,
  },
}))
