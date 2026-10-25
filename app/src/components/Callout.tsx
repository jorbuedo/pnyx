/**
 * Callout component.
 *
 * Inline severity-driven notification with icon and optional action.
 *
 * @module
 */

import type {ReactElement} from 'react'
import {Pressable, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

import type {ColorTokens} from '../theme'
import {ChamferBackground} from './Chamfer'
import {Typography} from './Typography'
import {UniIcon, type UniIconName} from './UniIcon'

/** Callout visual style variant */
export type CalloutVariant = 'info' | 'warning' | 'error' | 'success'

export type CalloutProps = {
  /** Callout message */
  message: string
  /** Visual style variant */
  variant?: CalloutVariant | undefined
  /** Custom icon name */
  icon?: UniIconName | undefined
  /** Action button text */
  actionLabel?: string | undefined
  /** Action button press handler */
  onAction?: (() => void) | undefined
  /** Test ID for the action button */
  actionTestID?: string | undefined
  /** Dismiss handler */
  onDismiss?: (() => void) | undefined
  /** Test ID for e2e testing */
  testID?: string | undefined
}

const variantConfig: Record<
  CalloutVariant,
  {
    icon: UniIconName
    bgKey: 'primaryMuted' | 'warningMuted' | 'errorMuted' | 'successMuted'
    textKey: 'infoDefault' | 'warningDefault' | 'errorDefault' | 'successDefault'
  }
> = {
  info: {icon: 'infoFilled', bgKey: 'primaryMuted', textKey: 'infoDefault'},
  warning: {icon: 'warningFilled', bgKey: 'warningMuted', textKey: 'warningDefault'},
  error: {icon: 'alertFilled', bgKey: 'errorMuted', textKey: 'errorDefault'},
  success: {icon: 'successFilled', bgKey: 'successMuted', textKey: 'successDefault'},
}

/**
 * Callout component.
 *
 * An inline notification for displaying severity-driven alerts within flows.
 *
 * @example
 * ```tsx
 * <Callout
 *   variant="warning"
 *   message="Network is currently congested"
 *   actionLabel="Learn more"
 *   onAction={handleLearnMore}
 *   onDismiss={handleDismiss}
 * />
 * ```
 */
export const Callout = ({
  message,
  variant = 'info',
  icon,
  actionLabel,
  onAction,
  actionTestID,
  onDismiss,
  testID,
}: CalloutProps): ReactElement => {
  styles.useVariants({variant})

  const config = variantConfig[variant]
  const textKey = config.textKey
  const iconName = icon ?? config.icon

  return (
    <View style={styles.container} testID={testID}>
      <ChamferBackground size="auto" fillToken={config.bgKey} />
      <UniIcon name={iconName} size="md" uniProps={(theme) => ({color: theme.colors[textKey]})} />
      <View style={styles.content}>
        <Typography variant="bodySm_regular" style={styles.text}>
          {message}
        </Typography>
        {actionLabel && onAction ? (
          <Pressable onPress={onAction} accessibilityRole="button" testID={actionTestID}>
            <Typography variant="bodySm_medium" style={styles.actionText}>
              {actionLabel}
            </Typography>
          </Pressable>
        ) : null}
      </View>
      {onDismiss ? (
        <Pressable onPress={onDismiss} accessibilityRole="button" style={styles.dismissButton}>
          <UniIcon name="close" size="sm" uniProps={(theme) => ({color: theme.colors[textKey]})} />
        </Pressable>
      ) : null}
    </View>
  )
}

const textFor = (colors: ColorTokens, variant: CalloutVariant) => colors[variantConfig[variant].textKey]

const styles = StyleSheet.create(({colors, spacing}) => ({
  container: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    padding: spacing.spacing12,
    gap: spacing.spacing12,
  },
  content: {
    flex: 1,
    gap: spacing.spacing4,
  },
  text: {
    variants: {
      variant: {
        info: {color: textFor(colors, 'info')},
        warning: {color: textFor(colors, 'warning')},
        error: {color: textFor(colors, 'error')},
        success: {color: textFor(colors, 'success')},
      },
    },
  },
  actionText: {
    textDecorationLine: 'underline',
    variants: {
      variant: {
        info: {color: textFor(colors, 'info')},
        warning: {color: textFor(colors, 'warning')},
        error: {color: textFor(colors, 'error')},
        success: {color: textFor(colors, 'success')},
      },
    },
  },
  dismissButton: {
    padding: spacing.spacing4,
  },
}))
