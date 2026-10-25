/**
 * Card component.
 *
 * The one surface container for grouping related content. No shadow — the app has
 * no elevated surfaces; separation comes from the surface colour against the
 * canvas. `outlined` adds a hairline edge, `selected` marks the active card.
 *
 * The corner is painted as a chamfered path, so Card — not the caller — owns the
 * surface properties listed in {@link CHAMFER_OWNED_SURFACE}. A caller that set
 * them through `style` would clip the painted path back into a rounded rectangle
 * or fill the corners it cut, so they are re-applied after the caller's style and
 * cannot be overridden. Tint a card with `fill` / `fillToken` instead.
 *
 * @module
 */

import {type ReactNode, useState} from 'react'
import {Pressable, View, type ViewProps} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

import type {NewColorTokens} from '../theme/tokens'
import {ChamferBackground, type ChamferedStyle, chamferedSurfaceStyle, HIGHLIGHT_BRACKETS} from './Chamfer'
import {SurfaceProvider} from './surface-context'

export type CardProps = Omit<ViewProps, 'style'> & {
  /** Card content */
  children: ReactNode
  /**
   * `filled` is the default surface, `outlined` adds a hairline edge, `selected`
   * marks the active card. Selection is Card's affordance — do not hand-roll a
   * border in the caller's style, it will not survive.
   */
  variant?: 'outlined' | 'filled' | 'selected' | undefined
  /**
   * Draws HUD-style brackets across the two cut corners. An emphasis affordance
   * for the few cards that need to be picked out of a list — it stops reading as
   * emphasis the moment more than one card on screen carries it.
   */
  highlighted?: boolean | undefined
  /**
   * Overrides the surface colour. For the few cards whose fill is functional
   * rather than thematic — a QR card is white so the code stays scannable.
   */
  fill?: string | undefined
  /**
   * Token form of `fill`, for a card tinted from the theme. Resolving it here
   * keeps the surface inside the painted path — a `backgroundColor` in the
   * caller's style would instead fill the corners the chamfer cut away.
   */
  fillToken?: keyof NewColorTokens | undefined
  /** Layout and spacing only — Card owns its corner and its fill. */
  style?: ChamferedStyle | readonly ChamferedStyle[] | undefined
  /** Press handler (optional). Card paints its own pressed surface. */
  onPress?: (() => void) | undefined
  onLongPress?: (() => void) | undefined
  disabled?: boolean | undefined
}

/** Hoisted so the memoised paint layer sees a stable prop, not a fresh object per render. */
/**
 * Empty, and load-bearing on web.
 *
 * The Unistyles babel plugin swaps `react-native` imports for its own factories only in
 * files that use Unistyles. Without a use, Card's `View` stayed a plain react-native-web
 * one, which flattens a *caller's* Unistyles style to nothing — `WalletGroupCard` asked
 * for `flexDirection: row` and got `column`, so every wallet row stacked its identicon,
 * name and chevron. Measured: the same style object read `row/16px/12px` on a bare View
 * and `column/0px/normal` through this component.
 *
 * Card genuinely owns no layout, so there is nothing to put here — the declaration itself
 * is the fix. Delete it and the rows break again.
 */
const styles = StyleSheet.create(() => ({unistylesBinding: {}}))

/**
 * Card component for grouping content.
 *
 * @example
 * ```tsx
 * import { StyleSheet } from 'react-native-unistyles'
 *
 * const cardStyles = StyleSheet.create((theme) => ({
 *   card: {
 *     padding: theme.spacing.spacing16,
 *   },
 * }))
 *
 * <Card style={cardStyles.card}>
 *   <Text>Card Title</Text>
 *   <Text>Card content</Text>
 * </Card>
 * ```
 */
export const Card = ({
  children,
  variant = 'filled',
  highlighted = false,
  fill,
  fillToken,
  style,
  onPress,
  onLongPress,
  disabled = false,
  ...props
}: CardProps) => {
  // The surface is painted, so press feedback cannot come from Pressable's style
  // callback — it has to be readable at render time.
  const [isPressed, setIsPressed] = useState(false)
  const cardStyle = chamferedSurfaceStyle(styles.unistylesBinding, ...(Array.isArray(style) ? style : [style]))

  // Every colour below is a token, resolved against the painted path by Unistyles.
  // Reading them here instead would put a `useUnistyles()` subscription on every
  // card on screen, and a theme change would then re-render all of them in JS.
  const edgeToken = variant === 'selected' ? 'primaryDefault' : variant === 'outlined' ? 'borderDefaultWeak' : null

  const surface = (
    <ChamferBackground
      size="auto"
      {...(isPressed && !disabled
        ? {fillToken: 'backgroundAlternativeHover' as const}
        : fill
          ? {fill}
          : {fillToken: fillToken ?? ('backgroundAlternative' as const)})}
      {...(edgeToken ? {borderToken: edgeToken} : {})}
      {...(highlighted ? {brackets: HIGHLIGHT_BRACKETS} : {})}
    />
  )

  if (onPress || onLongPress) {
    return (
      <Pressable
        style={cardStyle}
        onPress={onPress}
        onLongPress={onLongPress}
        disabled={disabled}
        onPressIn={() => setIsPressed(true)}
        onPressOut={() => setIsPressed(false)}
        {...props}
      >
        {surface}
        {/* Controls inside a card need a fill that separates them from it — see
            `surface-context`. Declared here so no call site has to know. */}
        <SurfaceProvider surface="card">{children}</SurfaceProvider>
      </Pressable>
    )
  }

  return (
    <View style={cardStyle} {...props}>
      {surface}
      <SurfaceProvider surface="card">{children}</SurfaceProvider>
    </View>
  )
}
