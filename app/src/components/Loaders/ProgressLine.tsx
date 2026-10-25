/**
 * Indeterminate progress line — a primary-tinted segment travelling across the top of a screen's
 * content.
 *
 * The quiet way to say "something is being fetched". It reserves no layout of its own, so it can
 * appear and disappear over already-rendered content without moving anything, and it takes no
 * touches — which is the point: a background refetch must never be a reason the user cannot switch
 * wallets while it runs.
 *
 * @module
 */

import {memo, useEffect, useState} from 'react'
import type {LayoutChangeEvent} from 'react-native'
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated'
import {StyleSheet} from 'react-native-unistyles'
import {segmentOffset, segmentWidth, TRAVEL_MS} from './progress-line-motion'

export type ProgressLineProps = {
  /** Whether a fetch is in flight. */
  readonly show: boolean
  readonly testID?: string | undefined
}

/**
 * `show` false renders nothing at all rather than a transparent bar: this sits on the wallet home,
 * the screen least able to afford an idle animation still driving frames.
 */
export const ProgressLine = memo(({show, testID}: ProgressLineProps) => {
  const [width, setWidth] = useState(0)
  const progress = useSharedValue(0)

  useEffect(() => {
    if (!show) {
      cancelAnimation(progress)
      progress.value = 0
      return
    }
    progress.value = 0
    progress.value = withRepeat(withTiming(1, {duration: TRAVEL_MS, easing: Easing.inOut(Easing.ease)}), -1, false)
    return () => {
      cancelAnimation(progress)
      progress.value = 0
    }
  }, [show, progress])

  const segment = useAnimatedStyle(() => ({
    width: segmentWidth(width),
    transform: [{translateX: segmentOffset(width, progress.value)}],
  }))

  const onLayout = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)

  if (!show) return null

  return (
    <Animated.View style={styles.track} onLayout={onLayout} pointerEvents="none" testID={testID}>
      {width > 0 && <Animated.View style={[styles.segment, segment]} />}
    </Animated.View>
  )
})

const styles = StyleSheet.create((theme) => ({
  // Absolute so it overlays the first pixels of content instead of pushing them down — a line that
  // moved the page every time a refetch began would be worse than the spinner it replaced.
  track: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 3,
    overflow: 'hidden',
    zIndex: 1,
    backgroundColor: theme.colors.primaryMuted,
  },
  segment: {
    height: 3,
    backgroundColor: theme.colors.primaryDefault,
  },
}))
