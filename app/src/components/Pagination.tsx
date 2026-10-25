/**
 * Pagination component.
 *
 * Page indicator dots for carousels and paged content.
 *
 * @module
 */

import {memo, type ReactElement} from 'react'
import {Pressable, View} from 'react-native'
import Animated, {useAnimatedStyle, withSpring} from 'react-native-reanimated'
import {StyleSheet, useUnistyles} from 'react-native-unistyles'

export type PaginationProps = {
  /** Total number of pages */
  total: number
  /** Current active page (0-indexed) */
  current: number
  /** Page change handler */
  onPageChange?: ((page: number) => void) | undefined
  /** Whether dots are pressable */
  interactive?: boolean | undefined
  /** Active dot color */
  activeColor?: string | undefined
  /** Inactive dot color */
  inactiveColor?: string | undefined
  /** Test ID for e2e testing */
  testID?: string | undefined
}

/**
 * Pagination component.
 *
 * Displays page indicator dots for multi-page content.
 *
 * @example
 * ```tsx
 * <Pagination
 *   total={5}
 *   current={currentPage}
 *   onPageChange={setCurrentPage}
 *   interactive
 * />
 * ```
 */
export const Pagination = memo(
  ({
    total,
    current,
    onPageChange,
    interactive = false,
    activeColor,
    inactiveColor,
    testID,
  }: PaginationProps): ReactElement => {
    const {theme} = useUnistyles()

    const activeDotColor = activeColor ?? theme.colors.primaryDefault
    const inactiveDotColor = inactiveColor ?? theme.colors.borderDefaultWeak

    return (
      <View style={styles.container} testID={testID}>
        {Array.from({length: total}, (_, index) => {
          const isActive = index === current

          return (
            <PaginationDot
              // biome-ignore lint/suspicious/noArrayIndexKey: pagination dots are position-based
              key={index}
              isActive={isActive}
              activeColor={activeDotColor}
              inactiveColor={inactiveDotColor}
              onPress={interactive && onPageChange ? () => onPageChange(index) : undefined}
            />
          )
        })}
      </View>
    )
  },
)

type PaginationDotProps = {
  isActive: boolean
  activeColor: string
  inactiveColor: string
  onPress?: (() => void) | undefined
}

const PaginationDot = memo(({isActive, activeColor, inactiveColor, onPress}: PaginationDotProps): ReactElement => {
  const animatedStyle = useAnimatedStyle(() => ({
    width: withSpring(isActive ? 24 : 8, {damping: 15, stiffness: 200}),
    backgroundColor: isActive ? activeColor : inactiveColor,
  }))

  const dot = <Animated.View style={[styles.dot, animatedStyle]} />

  if (onPress) {
    return (
      <Pressable onPress={onPress} accessibilityRole="button" hitSlop={8}>
        {dot}
      </Pressable>
    )
  }

  return dot
})

const styles = StyleSheet.create(({spacing, borderRadius}) => ({
  container: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    gap: spacing.spacing8,
  },
  dot: {
    height: 8,
    borderRadius: borderRadius.rounded4,
  },
}))
