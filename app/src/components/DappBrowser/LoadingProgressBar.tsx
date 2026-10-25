/**
 * Thin animated progress bar pinned to the bottom edge of the browser top bar
 * while a page is loading. Indeterminate — slides a gradient segment back and
 * forth until `visible` is false, then fades out. Replaces the v1 absolute
 * spinner over the WebView.
 *
 * @module
 */

import {useEffect} from 'react'
import {View} from 'react-native'
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated'
import {StyleSheet} from 'react-native-unistyles'

const SEGMENT_RATIO = 0.35

type LoadingProgressBarProps = {
  visible: boolean
}

export const LoadingProgressBar = ({visible}: LoadingProgressBarProps) => {
  const opacity = useSharedValue(0)
  const position = useSharedValue(-1)

  useEffect(() => {
    if (visible) {
      opacity.value = withTiming(1, {duration: 120})
      position.value = withRepeat(withTiming(1, {duration: 1100, easing: Easing.inOut(Easing.ease)}), -1, false)
    } else {
      opacity.value = withTiming(0, {duration: 220})
    }
    return () => {
      cancelAnimation(opacity)
      cancelAnimation(position)
    }
  }, [visible, opacity, position])

  const containerStyle = useAnimatedStyle(() => ({opacity: opacity.value}))
  const segmentStyle = useAnimatedStyle(() => ({
    transform: [{translateX: `${(position.value + 1) * 50}%`}],
  }))

  return (
    <Animated.View style={[styles.container, containerStyle, {pointerEvents: 'none'}]}>
      <Animated.View style={[styles.segment, segmentStyle]}>
        <View style={styles.segmentInner} />
      </Animated.View>
    </Animated.View>
  )
}

const styles = StyleSheet.create((theme) => ({
  container: {
    position: 'absolute' as const,
    left: 0,
    right: 0,
    bottom: 0,
    height: 2,
    overflow: 'hidden' as const,
  },
  segment: {
    position: 'absolute' as const,
    left: 0,
    top: 0,
    bottom: 0,
    width: `${SEGMENT_RATIO * 100}%`,
    backgroundColor: theme.colors.primaryDefault,
  },
  segmentInner: {
    flex: 1,
    backgroundColor: theme.colors.primaryDefault,
  },
}))
