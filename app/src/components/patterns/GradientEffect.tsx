/**
 * GradientEffect component.
 *
 * Standalone gradient overlay — reusable on any surface (card, panel, screen section).
 * Can wrap children or act as a pure overlay with `style.pointerEvents = 'none'`.
 * Uses theme gradient tokens by default so it adapts to the active brand and colour scheme.
 *
 * @module
 */

import {LinearGradient} from 'expo-linear-gradient'
import type {ComponentProps, ReactNode} from 'react'
import type {ViewStyle} from 'react-native'
import {useUnistyles, withUnistyles} from 'react-native-unistyles'

export type GradientEffectProps = {
  /** Content to render inside the gradient container */
  children?: ReactNode
  /**
   * Gradient direction.
   * - `diagonal` — top-left to bottom-right (brand default)
   * - `vertical` — top to bottom
   * - `horizontal` — left to right
   */
  direction?: 'diagonal' | 'vertical' | 'horizontal'
  /**
   * Override the two endpoint colours.  When omitted, the active theme's
   * `gradientStart` / `gradientEnd` tokens are used.
   */
  colors?: [string, string]
  /** Additional styles applied to the gradient container */
  style?: ViewStyle
}

// LinearGradient is third-party, so Unistyles does not bind it: a `styles.x` object
// passed straight to it is dropped and the gradient collapses to its content.
const UniLinearGradient = withUnistyles(LinearGradient)

type GradientVector = {start: {x: number; y: number}; end: {x: number; y: number}}

const VECTORS: Record<Required<GradientEffectProps>['direction'], GradientVector> = {
  diagonal: {start: {x: 0, y: 0}, end: {x: 1, y: 1}},
  vertical: {start: {x: 0, y: 0}, end: {x: 0, y: 1}},
  horizontal: {start: {x: 0, y: 0}, end: {x: 1, y: 0}},
}

/**
 * Gradient wrapper or overlay for any surface.
 *
 * Uses a two-stop gradient (`start → end`) to create a
 * soft, diffused look. Defaults to the diagonal brand gradient.
 *
 * @example
 * ```tsx
 * // As a wrapping container
 * <GradientEffect direction="vertical" style={{flex: 1}}>
 *   <ScreenContent />
 * </GradientEffect>
 *
 * // As a purely decorative overlay (no children)
 * <View style={[StyleSheet.absoluteFill, {pointerEvents: 'none'}]}>
 *   <GradientEffect style={{flex: 1}} />
 * </View>
 * ```
 */
export const GradientEffect = ({children, direction = 'diagonal', colors, style}: GradientEffectProps) => {
  const {theme} = useUnistyles()

  const startColor = colors?.[0] ?? theme.colors.gradientStart
  const endColor = colors?.[1] ?? theme.colors.gradientEnd
  const gradientColors: [string, string] = [startColor, endColor]
  const {start, end} = VECTORS[direction]
  // Cast: expo-linear-gradient is hoisted against the workspace-root
  // react-native types (0.86) while this app pins 0.83 — structurally
  // identical style shapes.
  const gradientStyle = style as ComponentProps<typeof LinearGradient>['style']

  return (
    <UniLinearGradient colors={gradientColors} start={start} end={end} style={gradientStyle}>
      {children}
    </UniLinearGradient>
  )
}
