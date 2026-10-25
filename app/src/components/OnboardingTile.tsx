/**
 * Onboarding method tile.
 *
 * Compact row with icon + title (optional badge) + subtitle + chevron, used on
 * the onboarding method-picker screens.
 *
 * @module
 */

import type {ReactNode} from 'react'
import {Pressable, View} from 'react-native'
import Svg, {Polyline} from 'react-native-svg'
import {StyleSheet, withUnistyles} from 'react-native-unistyles'

import {ChamferBackground} from './Chamfer'
import {Typography} from './Typography'

/**
 * Thin stroke chevron (16px, `stroke="currentColor"`, `stroke-width="2"`).
 * The bundled `ChevronRight.svg` icon is a heavy filled shape that reads as
 * bright white against the dark tile surface; this stroke version blends
 * correctly with the muted chevron color.
 */
const TileChevron = ({color}: {color: string}) => (
  <Svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2}>
    <Polyline points="9 18 15 12 9 6" />
  </Svg>
)

// `stroke` is a raw SVG color prop, so it can't repaint via the native shadow
// tree on a theme toggle. Wrapping once lets `uniProps` feed the tint without a
// JS re-render.
const UniTileChevron = withUnistyles(TileChevron)

export type OnboardingTileProps = {
  /** Icon rendered inside the 40x40 leading container. */
  icon: ReactNode
  /** Tile title (bold). */
  title: string
  /** Tile subtitle (muted). */
  subtitle?: string | undefined
  /** Optional badge text shown next to the title (e.g. "Recommended"). */
  badge?: string | undefined
  /** Apply the recommended/featured styling (accent border + accent-tinted bg). */
  recommended?: boolean | undefined
  /** Press handler. */
  onPress: () => void
  /** Disable interaction. */
  isDisabled?: boolean | undefined
  /** Test ID. */
  testID?: string | undefined
}

export const OnboardingTile = ({
  icon,
  title,
  subtitle,
  badge,
  recommended = false,
  onPress,
  isDisabled = false,
  testID,
}: OnboardingTileProps) => {
  return (
    <Pressable
      onPress={onPress}
      disabled={isDisabled}
      style={({pressed}) => [
        styles.tile,
        pressed && !isDisabled && styles.tilePressed,
        isDisabled && styles.tileDisabled,
      ]}
      testID={testID}
    >
      <ChamferBackground
        size="auto"
        fillToken={recommended ? 'primaryMuted' : 'backgroundAlternativeHover'}
        borderToken={recommended ? 'primaryDefault' : 'borderInteractive'}
        borderWidth={1}
      />
      <View style={styles.iconContainer}>
        <ChamferBackground size="auto" fillToken="backgroundAlternative" borderToken="borderSubtle" borderWidth={1} />
        {icon}
      </View>
      <View style={styles.body}>
        <View style={styles.titleRow}>
          <Typography variant="bodyMd_medium" style={styles.title} singleLine>
            {title}
          </Typography>
          {badge ? (
            <View style={styles.badge}>
              <ChamferBackground size="auto" fillToken="primaryDefault" />
              <Typography variant="bodyXs_regular" style={styles.badgeText}>
                {badge}
              </Typography>
            </View>
          ) : null}
        </View>
        {subtitle ? (
          <Typography variant="bodySm_regular" style={styles.subtitle}>
            {subtitle}
          </Typography>
        ) : null}
      </View>
      <UniTileChevron uniProps={(theme) => ({color: theme.colors.textMuted})} />
    </Pressable>
  )
}

const styles = StyleSheet.create((theme) => ({
  tile: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.spacing12,
    paddingVertical: theme.spacing.spacing12,
    paddingHorizontal: theme.spacing.spacing16,
  },
  tilePressed: {
    opacity: 0.7,
  },
  tileDisabled: {
    opacity: 0.4,
  },
  iconContainer: {
    flexShrink: 0,
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing.spacing2,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.spacing6,
  },
  title: {
    color: theme.colors.textDefault,
    flexShrink: 1,
  },
  subtitle: {
    color: theme.colors.textAlternative,
  },
  badge: {
    paddingVertical: 2,
    paddingHorizontal: theme.spacing.spacing6,
  },
  badgeText: {
    color: theme.colors.primaryInverse,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
}))
