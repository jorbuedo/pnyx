/**
 * WarningMessage component.
 *
 * An alert/warning message component with icon and text.
 *
 * @module
 */

import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

import {Typography} from './Typography'
import {UniIcon, type UniIconName} from './UniIcon'

/** Available warning message variants */
export type WarningMessageVariant = 'default' | 'error' | 'warning'

export type WarningMessageProps = {
  /** Color variant */
  variant?: WarningMessageVariant
  /** Message text */
  label?: string
  /** Number of lines for text truncation (0 = unlimited) */
  numberOfLines?: number
  /** Test ID for e2e testing */
  testID?: string
}

/** Maps variant to icon name */
const variantToIconName: Record<WarningMessageVariant, UniIconName | null> = {
  default: null,
  error: 'alert',
  warning: 'warning',
}

/**
 * WarningMessage component.
 *
 * Displays an alert or warning message with an optional icon.
 *
 * @example
 * ```tsx
 * <WarningMessage label="Please check your input" variant="warning" />
 * <WarningMessage label="An error occurred" variant="error" />
 * <WarningMessage label="General information" />
 * ```
 */
export const WarningMessage = ({variant = 'default', label = '', numberOfLines = 0, testID}: WarningMessageProps) => {
  const iconName = variantToIconName[variant]

  styles.useVariants({
    fontColor: variant === 'default' ? undefined : variant,
  })

  return (
    <View style={styles.container}>
      {iconName ? (
        <UniIcon
          name={iconName}
          size="sm"
          uniProps={(theme) => ({
            color: variant === 'error' ? theme.colors.errorDefault : theme.colors.warningDefault,
          })}
        />
      ) : null}
      <View style={styles.textContainer}>
        <Typography
          variant="bodySm_regular"
          numberOfLines={numberOfLines || undefined}
          style={styles.text}
          testID={testID}
        >
          {label}
        </Typography>
      </View>
    </View>
  )
}

const styles = StyleSheet.create(({colors, spacing}) => ({
  text: {
    variants: {
      fontColor: {
        default: {color: colors.textAlternative},
        error: {color: colors.errorDefault},
        warning: {color: colors.warningDefault},
      },
    },
  },
  textContainer: {
    flex: 1,
  },
  container: {
    flexDirection: 'row',
    gap: spacing.spacing4,
  },
}))
