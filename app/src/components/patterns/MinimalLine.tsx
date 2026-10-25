/**
 * MinimalLine component.
 *
 * Fine-weight line for guiding attention and defining visual structure.
 * A 1 dp hairline in either `default` (muted border) or `accent` (cyan→blue gradient) variants.
 * Non-interactive — does not intercept touch events.
 *
 * @module
 */

import {LinearGradient} from 'expo-linear-gradient'
import type {ComponentProps} from 'react'
import type {ViewStyle} from 'react-native'
import {View} from 'react-native'
import {StyleSheet, useUnistyles} from 'react-native-unistyles'

export type MinimalLineProps = {
  /** Line orientation (default `horizontal`) */
  orientation?: 'horizontal' | 'vertical'
  /**
   * Visual variant.
   * - `default` — subtle muted border using the theme `borderDefaultWeak` token
   * - `accent` — secondary-to-primary brand gradient (theme-aware)
   */
  variant?: 'default' | 'accent'
  /** Additional styles applied to the line element */
  style?: ViewStyle
}

/**
 * Hairline divider / structural rule.
 *
 * @example
 * ```tsx
 * // Subtle section separator
 * <MinimalLine />
 *
 * // Brand accent rule
 * <MinimalLine variant="accent" />
 *
 * // Vertical separator
 * <MinimalLine orientation="vertical" style={{height: 32}} />
 * ```
 */
export const MinimalLine = ({orientation = 'horizontal', variant = 'default', style}: MinimalLineProps) => {
  const {theme} = useUnistyles()
  const isHorizontal = orientation === 'horizontal'
  const gradientColors: [string, string] = [theme.colors.secondaryDefault, theme.colors.primaryHover]

  if (variant === 'accent') {
    return (
      <LinearGradient
        colors={gradientColors}
        start={{x: 0, y: 0}}
        end={isHorizontal ? {x: 1, y: 0} : {x: 0, y: 1}}
        style={
          [isHorizontal ? styles.horizontal : styles.vertical, style, {pointerEvents: 'none'}] as ComponentProps<
            typeof LinearGradient
          >['style']
        }
      />
    )
  }

  return (
    <View
      style={[isHorizontal ? styles.horizontal : styles.vertical, styles.defaultLine, style, {pointerEvents: 'none'}]}
    />
  )
}

const styles = StyleSheet.create(({colors}) => ({
  horizontal: {
    height: 1,
    width: '100%',
  },
  vertical: {
    width: 1,
    height: '100%',
  },
  defaultLine: {
    backgroundColor: colors.borderDefaultWeak,
  },
}))
