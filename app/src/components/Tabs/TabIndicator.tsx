/**
 * TabIndicator component.
 *
 * Animated indicator bar showing active tab position.
 *
 * @module
 */

import {memo, type ReactElement} from 'react'
import Animated, {useAnimatedStyle, withSpring} from 'react-native-reanimated'
import {StyleSheet} from 'react-native-unistyles'

export type TabIndicatorProps = {
  /** Width of the indicator */
  width: number
  /** X offset position */
  offset: number
  /** Test ID for e2e testing */
  testID?: string | undefined
}

/**
 * TabIndicator component.
 *
 * Animated line that moves to indicate the active tab.
 *
 * @example
 * ```tsx
 * <TabIndicator
 *   width={tabWidths[activeIndex]}
 *   offset={tabOffsets[activeIndex]}
 * />
 * ```
 */
export const TabIndicator = memo(({width, offset, testID}: TabIndicatorProps): ReactElement => {
  const animatedStyle = useAnimatedStyle(() => ({
    width: withSpring(width, {damping: 20, stiffness: 200}),
    transform: [{translateX: withSpring(offset, {damping: 20, stiffness: 200})}],
  }))

  return <Animated.View style={[styles.indicator, animatedStyle]} testID={testID} />
})

const styles = StyleSheet.create(({borderRadius, colors}) => ({
  indicator: {
    height: 2,
    backgroundColor: colors.primaryDefault,
    borderRadius: borderRadius.rounded4,
    position: 'absolute' as const,
    bottom: 0,
    left: 0,
  },
}))
