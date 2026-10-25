/**
 * Accordion component.
 *
 * Expandable/collapsible content section with a Cell-style header.
 * Header supports optional left content (avatar), title, description,
 * right-side values, and an animated chevron.
 *
 * Uses LayoutAnimation for smooth height transitions and Reanimated for
 * chevron rotation and body opacity animations.
 *
 * @module
 */

import {memo, type ReactElement, type ReactNode, useEffect, useState} from 'react'
import {LayoutAnimation, Pressable, View} from 'react-native'
import Animated, {useAnimatedStyle, withTiming} from 'react-native-reanimated'
import {StyleSheet} from 'react-native-unistyles'

import {platformIsWeb} from '../platform'
import {ChamferBackground, chamferedSurfaceStyle} from './Chamfer'
import {Skeleton} from './Loaders/Skeleton'
import {Typography} from './Typography'
import {UniIcon} from './UniIcon'

export type AccordionSpacing = 'default' | 'compact' | 'reduced'

export type AccordionProps = {
  /** Header primary text */
  title?: string | undefined
  /** Render the title in bold (`bodyMd_bold`) instead of medium weight. Used by callers that need to draw extra attention to a single accordion in a list (e.g. the "current" trade in a multi-step swap review). */
  boldTitle?: boolean | undefined
  /** Header subtitle below title */
  description?: string | undefined
  /** Right-side primary value (e.g. "$1,230") */
  rightTitle?: string | undefined
  /** Right-side secondary value (e.g. "0.546 ETH") */
  rightDescription?: string | undefined
  /** Horizontal padding — default (16px), compact (12px, for grouped layout), or reduced (8px, for extension) */
  spacing?: AccordionSpacing | undefined
  /** Expandable content */
  children: ReactNode
  /** Whether initially expanded */
  defaultExpanded?: boolean | undefined
  /** Controlled expanded state */
  isExpanded?: boolean | undefined
  /** Expansion change handler */
  onExpandedChange?: ((expanded: boolean) => void) | undefined
  /** Whether accordion is disabled */
  isDisabled?: boolean | undefined
  /** Left slot — typically an Avatar (44px min-height touch area) */
  leftContent?: ReactNode | undefined
  /**
   * Right slot, before the chevron — for a control rather than a value.
   *
   * Distinct from `rightTitle`/`rightDescription`, which are text. It sits *outside* the
   * header's own `Pressable` in the tree order but inside it visually, so a control placed
   * here must stop its own press from reaching the header, or tapping it also toggles the
   * accordion.
   */
  rightContent?: ReactNode | undefined
  /** Show skeleton placeholders in header while data is loading */
  isLoading?: boolean | undefined
  /** Test ID for e2e testing */
  testID?: string | undefined
}

/**
 * Accordion component with animated expand/collapse.
 *
 * @example
 * ```tsx
 * // Simple with title only
 * <Accordion title="Transaction Details" defaultExpanded>
 *   <DataRow label="Fee" value="0.17 ADA" />
 * </Accordion>
 *
 * // With avatar, description, and right-side values
 * <Accordion
 *   leftContent={<AvatarToken token="ETH" />}
 *   title="Ethereum"
 *   description="Mainnet"
 *   rightTitle="$1,230"
 *   rightDescription="0.546 ETH"
 * >
 *   <TokenDetails />
 * </Accordion>
 *
 * // Grouped layout (Space between: False)
 * <Accordion spacing="compact" title="Grouped Item">
 *   <TokenDetails />
 * </Accordion>
 *
 * // Loading state — skeleton placeholders in header
 * <Accordion isLoading>
 *   {null}
 * </Accordion>
 * ```
 */
export const Accordion = memo(
  ({
    title,
    boldTitle = false,
    description,
    rightTitle,
    rightDescription,
    spacing = 'default',
    isLoading = false,
    children,
    defaultExpanded = false,
    isExpanded: controlledExpanded,
    onExpandedChange,
    isDisabled = false,
    leftContent,
    rightContent,
    testID,
  }: AccordionProps): ReactElement => {
    const [internalExpanded, setInternalExpanded] = useState(defaultExpanded)
    const [focused, setFocused] = useState(false)
    const [headerPressed, setHeaderPressed] = useState(false)

    useEffect(() => {
      if (isDisabled || isLoading) setFocused(false)
    }, [isDisabled, isLoading])

    const isControlled = controlledExpanded !== undefined
    const isExpanded = isControlled ? controlledExpanded : internalExpanded

    const handlePress = () => {
      if (isDisabled || isLoading) return
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut)
      if (isControlled) {
        onExpandedChange?.(!controlledExpanded)
      } else {
        setInternalExpanded((prev) => {
          const next = !prev
          onExpandedChange?.(next)
          return next
        })
      }
    }

    const iconAnimatedStyle = useAnimatedStyle(() => ({
      transform: [{rotate: withTiming(isExpanded ? '180deg' : '0deg', {duration: 200})}],
    }))

    const contentAnimatedStyle = useAnimatedStyle(() => ({
      opacity: withTiming(isExpanded ? 1 : 0, {duration: 200}),
    }))

    const hasRightContent = rightTitle != null || rightDescription != null

    return (
      <View
        // Focus ring — web/extension only (outline draws inward so no layout shift on native)
        style={chamferedSurfaceStyle(styles.container, platformIsWeb && focused ? styles.focusRing : undefined)}
        testID={testID}
      >
        {/* Open draws a subtle surface; closed paints nothing. */}
        {isExpanded && <ChamferBackground size="auto" fillToken="backgroundLayer1" />}
        <Pressable
          style={styles.header(spacing, isDisabled)}
          onPressIn={() => setHeaderPressed(true)}
          onPressOut={() => setHeaderPressed(false)}
          onPress={handlePress}
          onFocus={platformIsWeb ? () => setFocused(true) : undefined}
          onBlur={platformIsWeb ? () => setFocused(false) : undefined}
          accessibilityRole="button"
          accessibilityState={{expanded: isExpanded, disabled: isDisabled}}
        >
          {headerPressed && !isDisabled && !isLoading && (
            <ChamferBackground size="auto" fillToken="backgroundPressed" />
          )}
          {isLoading ? (
            <View style={styles.leftContent}>
              <Skeleton show width={40} height={40} shape="circle">
                {null}
              </Skeleton>
            </View>
          ) : leftContent != null ? (
            <View style={styles.leftContent}>{leftContent}</View>
          ) : null}

          {isLoading ? (
            <View style={[styles.centerContent, styles.loadingGap]}>
              <Skeleton show width={35} height={12}>
                {null}
              </Skeleton>
              <Skeleton show width={79} height={12}>
                {null}
              </Skeleton>
            </View>
          ) : (
            <View style={styles.centerContent}>
              {title != null ? (
                <Typography variant={boldTitle ? 'bodyMd_bold' : 'bodyMd_medium'} style={styles.titleText}>
                  {title}
                </Typography>
              ) : null}
              {description != null ? (
                <Typography variant="bodyMd_regular" style={styles.descriptionText}>
                  {description}
                </Typography>
              ) : null}
            </View>
          )}

          {isLoading ? (
            <View style={[styles.rightContent, styles.loadingGap]}>
              <Skeleton show width={43} height={12}>
                {null}
              </Skeleton>
              <Skeleton show width={64} height={12}>
                {null}
              </Skeleton>
            </View>
          ) : hasRightContent ? (
            <View style={styles.rightContent}>
              {rightTitle != null ? (
                <Typography variant="bodyMd_medium" style={styles.rightText}>
                  {rightTitle}
                </Typography>
              ) : null}
              {rightDescription != null ? (
                <Typography variant="bodyMd_regular" style={[styles.rightText, styles.descriptionText]}>
                  {rightDescription}
                </Typography>
              ) : null}
            </View>
          ) : null}

          {rightContent != null ? <View style={styles.rightSlot}>{rightContent}</View> : null}

          <View style={styles.chevron}>
            {isLoading ? (
              <Skeleton show width={20} height={20} shape="circle">
                {null}
              </Skeleton>
            ) : (
              <Animated.View style={iconAnimatedStyle}>
                <UniIcon name="angleDown" size="sm" uniProps={(theme) => ({color: theme.colors.iconDefault})} />
              </Animated.View>
            )}
          </View>
        </Pressable>

        {isExpanded ? (
          <Animated.View style={[styles.content(spacing), contentAnimatedStyle]}>{children}</Animated.View>
        ) : null}
      </View>
    )
  },
)

const hPadFor = (spacing: {spacing8: number; spacing12: number; spacing16: number}, s: AccordionSpacing) =>
  s === 'reduced' ? spacing.spacing8 : s === 'compact' ? spacing.spacing12 : spacing.spacing16

const styles = StyleSheet.create(({colors, spacing}) => ({
  // The expanded surface is painted, not a background: the corner is a cut, and
  // `overflow: hidden` here would clip the paint back to a rectangle.
  container: {},
  focusRing: {
    outlineStyle: 'solid' as const,
    outlineWidth: 2,
    outlineColor: colors.borderFocus,
    outlineOffset: -2,
  },
  header: (s: AccordionSpacing, isDisabled: boolean) => ({
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    paddingHorizontal: hPadFor(spacing, s),
    paddingVertical: spacing.spacing12,
    minHeight: 68,
    opacity: isDisabled ? 0.4 : 1,
    gap: spacing.spacing8,
  }),
  loadingGap: {
    gap: spacing.spacing4,
  },
  descriptionText: {
    color: colors.textAlternative,
  },
  leftContent: {
    minHeight: 44,
    justifyContent: 'center' as const,
    alignItems: 'center' as const,
    paddingRight: spacing.spacing4,
    paddingVertical: spacing.spacing2,
  },
  centerContent: {
    flex: 1,
    justifyContent: 'center' as const,
    paddingRight: spacing.spacing4,
  },
  titleText: {
    flexShrink: 1,
  },
  rightContent: {
    alignItems: 'flex-end' as const,
    justifyContent: 'center' as const,
    minHeight: 44,
  },
  rightText: {
    textAlign: 'right' as const,
  },
  rightSlot: {
    minHeight: 44,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
  chevron: {
    width: 28,
    minHeight: 44,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
  content: (s: AccordionSpacing) => ({
    paddingHorizontal: hPadFor(spacing, s),
    paddingBottom: spacing.spacing16,
    overflow: 'hidden' as const,
  }),
}))
