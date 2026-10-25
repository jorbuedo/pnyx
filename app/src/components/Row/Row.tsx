/**
 * Row component.
 *
 * The one list-row anatomy: an optional left slot, a label with an optional
 * second line, optional mid content, and a right slot. `SettingsRow` is this
 * component under a settings-flavoured prop vocabulary — it maps onto Row rather
 * than re-implementing it, so the padding, border, press feedback and typography
 * are defined once.
 *
 * @module
 */

import {type ReactElement, type ReactNode, useState} from 'react'
import {Pressable, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

import type {NewColorTokens} from '../../theme/tokens'
import {ChamferBackground} from '../Chamfer'
import {Typography} from '../Typography'
import {UniIcon, type UniIconName} from '../UniIcon'

export type RowProps = {
  /** Left side content (usually icon or avatar) */
  leftContent?: ReactNode | undefined
  /** Left side icon by name — shorthand for a `leftContent` holding one icon. */
  leftIcon?: UniIconName | undefined
  /** Tint for `leftIcon`. `null` leaves the asset's own fill alone. */
  iconColor?: keyof NewColorTokens | null | undefined
  /** Primary label text */
  label?: string | undefined
  /** Rendered beside the label, on the same line (a badge, a chain dot). */
  labelAccessory?: ReactNode | undefined
  /** Secondary/subtitle text */
  subtitle?: string | undefined
  /** Content between the label and the right side (e.g. a sparkline) */
  midContent?: ReactNode | undefined
  /** Right side content */
  rightContent?: ReactNode | undefined
  /** Right side icon name */
  rightIcon?: UniIconName | undefined
  /** Press handler */
  onPress?: (() => void) | undefined
  /** Whether row is disabled */
  isDisabled?: boolean | undefined
  /** Whether to show bottom border */
  withBorder?: boolean | undefined
  /** Vertical rhythm. `lg` is the roomier settings-list spacing. */
  size?: 'md' | 'lg' | undefined
  /** Paints the label in the error colour, for destructive actions. */
  destructive?: boolean | undefined
  /**
   * Clamps the label and subtitle to one line each. A list row truncates so the
   * rows stay a uniform height; a settings row lets its description wrap.
   */
  singleLine?: boolean | undefined
  /** Test ID for e2e testing */
  testID?: string | undefined
}

/**
 * Row component.
 *
 * A flexible row layout commonly used in lists and settings.
 *
 * @example
 * ```tsx
 * <Row
 *   leftContent={<Avatar icon="wallet" size="sm" />}
 *   label="My Wallet"
 *   subtitle="$1,234.56"
 *   rightIcon="chevronRight"
 *   onPress={handlePress}
 * />
 * ```
 */
export const Row = ({
  leftContent,
  leftIcon,
  iconColor = 'iconDefault',
  label,
  labelAccessory,
  subtitle,
  midContent,
  rightContent,
  rightIcon,
  onPress,
  isDisabled = false,
  withBorder = false,
  size = 'md',
  destructive = false,
  singleLine = true,
  testID,
}: RowProps): ReactElement => {
  styles.useVariants({size, destructive})
  // The press surface is painted, so it cannot be driven from Pressable's style
  // callback — a background style there would draw a square behind a cut row.
  const [isPressed, setIsPressed] = useState(false)

  const left =
    leftContent ??
    (leftIcon ? (
      <UniIcon name={leftIcon} size="md" uniProps={(theme) => (iconColor ? {color: theme.colors[iconColor]} : {})} />
    ) : null)

  const content = (
    <View style={styles.container(withBorder, isDisabled)} testID={testID}>
      {left ? <View style={styles.leftContent}>{left}</View> : null}
      <View style={styles.centerContent}>
        {label || labelAccessory ? (
          <View style={styles.labelRow}>
            {label ? (
              <Typography variant="bodyMd_medium" style={styles.label} {...(singleLine ? {numberOfLines: 1} : {})}>
                {label}
              </Typography>
            ) : null}
            {labelAccessory}
          </View>
        ) : null}
        {subtitle ? (
          <Typography variant="bodySm_regular" style={styles.subtitle} {...(singleLine ? {numberOfLines: 1} : {})}>
            {subtitle}
          </Typography>
        ) : null}
      </View>
      {midContent ? <View style={styles.midContent}>{midContent}</View> : null}
      {rightContent ? <View style={styles.rightContent}>{rightContent}</View> : null}
      {rightIcon ? (
        <UniIcon name={rightIcon} size="sm" uniProps={(theme) => ({color: theme.colors.iconDefault})} />
      ) : null}
    </View>
  )

  if (onPress && !isDisabled) {
    return (
      <Pressable
        onPress={onPress}
        onPressIn={() => setIsPressed(true)}
        onPressOut={() => setIsPressed(false)}
        accessibilityRole="button"
        testID={testID ? `${testID}-pressable` : undefined}
      >
        {isPressed && <ChamferBackground size="auto" fillToken="backgroundHover" />}
        {content}
      </Pressable>
    )
  }

  return content
}

const styles = StyleSheet.create(({spacing, colors}) => ({
  container: (withBorder: boolean, isDisabled: boolean) => ({
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    paddingHorizontal: spacing.spacing16,
    borderBottomWidth: withBorder ? 1 : 0,
    borderBottomColor: colors.borderDefaultWeak,
    opacity: isDisabled ? 0.4 : 1,
    gap: spacing.spacing12,
    variants: {
      size: {
        md: {paddingVertical: spacing.spacing12},
        lg: {paddingVertical: spacing.spacing20},
      },
    },
  }),
  leftContent: {
    flexShrink: 0,
  },
  centerContent: {
    flex: 1,
    justifyContent: 'center' as const,
    gap: spacing.spacing4,
  },
  labelRow: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: spacing.spacing8,
  },
  label: {
    variants: {
      destructive: {
        true: {color: colors.errorDefault},
        false: {color: colors.textDefault},
      },
    },
  },
  subtitle: {
    color: colors.textAlternative,
  },
  midContent: {},
  rightContent: {
    flexShrink: 0,
  },
}))
