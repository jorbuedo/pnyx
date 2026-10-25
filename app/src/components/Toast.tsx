/**
 * Toast component.
 *
 * Dark pill notification: rounded
 * pill background, subtle border, single line of text, and an optional small
 * variant icon. No close button — toasts auto-dismiss.
 *
 * @module
 */

import {Pressable, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

import type {NewColorTokens} from '../theme/tokens'
import {ChamferBackground} from './Chamfer'
import {Typography} from './Typography'
import {UniIcon, type UniIconName} from './UniIcon'

export type ToastVariant = 'neutral' | 'info' | 'success' | 'warning' | 'error'

export type ToastAction = {
  readonly label: string
  readonly onPress: () => void
}

export type ToastProps = {
  /** Toast message */
  message: string
  /** Toast variant — `neutral` omits the leading icon */
  variant?: ToastVariant
  /** Optional inline action button (e.g. "Continue swap"). */
  action?: ToastAction
  /** Max lines for the message body. Defaults to 1. Use 2 when the toast
   * carries a longer prompt + action button that won't fit single-line.
   * `'none'` removes the cap so the text wraps freely without ellipsis. */
  maxLines?: 1 | 2 | 'none'
  /** Test selector. The action button gets `${testID}-action`. */
  testID?: string
}

type IconConfig = {name: UniIconName; colorKey: keyof NewColorTokens}
const variantIconMap: Record<Exclude<ToastVariant, 'neutral'>, IconConfig> = {
  info: {name: 'infoFilled', colorKey: 'primaryDefault'},
  success: {name: 'successFilled', colorKey: 'successDefault'},
  warning: {name: 'warningFilled', colorKey: 'warningDefault'},
  error: {name: 'alertFilled', colorKey: 'errorDefault'},
}

/**
 * Toast component for transient notifications.
 *
 * @example
 * ```tsx
 * <Toast variant="success" message="Cardano enabled" />
 * <Toast variant="neutral" message="Copied!" />
 * ```
 */
export const Toast = ({message, variant = 'neutral', action, maxLines = 1, testID}: ToastProps) => {
  const iconConfig = variant === 'neutral' ? null : variantIconMap[variant]

  return (
    <View style={styles.container} testID={testID}>
      <ChamferBackground size="auto" fillToken="overlayDefault" borderToken="borderDefaultStrong" />
      {iconConfig && (
        // uniProps lets withUnistyles resolve the tint reactively per theme — passing
        // a static `color` resolved outside the wrapper drops to undefined inside the
        // sonner overlay context, which is why the toast was rendering tint-less.
        <UniIcon name={iconConfig.name} size="sm" uniProps={(theme) => ({color: theme.colors[iconConfig.colorKey]})} />
      )}
      <Typography
        variant="bodySm_medium"
        style={styles.message}
        numberOfLines={maxLines === 'none' ? undefined : maxLines}
      >
        {message}
      </Typography>
      {action ? (
        <Pressable
          onPress={action.onPress}
          style={styles.action}
          hitSlop={8}
          testID={testID ? `${testID}-action` : undefined}
        >
          <Typography variant="bodySm_medium" style={styles.actionLabel}>
            {action.label}
          </Typography>
        </Pressable>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create((theme) => ({
  container: {
    // sonner-native renders custom toasts inside two `width: 100%` wrappers
    // (the Positioner and the swipe handler). `alignSelf: 'center'` keeps the
    // row hugging its contents as a pill instead of stretching edge-to-edge.
    alignSelf: 'center',
    maxWidth: '90%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.spacing8,
    paddingHorizontal: theme.spacing.spacing16,
    paddingVertical: theme.spacing.spacing8,
  },
  message: {
    color: theme.colors.primaryInverse,
    flexShrink: 1,
  },
  action: {
    paddingLeft: theme.spacing.spacing8,
    paddingVertical: theme.spacing.spacing4,
    borderLeftWidth: 1,
    borderLeftColor: theme.colors.borderDefaultStrong,
  },
  actionLabel: {
    color: theme.colors.primaryDefault,
  },
}))
