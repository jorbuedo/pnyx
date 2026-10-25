/**
 * Tag component.
 *
 * A compact label component with icon support and color variants.
 *
 * @module
 */

import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

import type {NewColorTokens} from '../theme/tokens'

import {ChamferBackground} from './Chamfer'
import {Typography} from './Typography'
import {UniIcon, type UniIconName} from './UniIcon'

/** Available tag size options */
export type TagSize = 'sm' | 'md'

/** Available tag variant options */
export type TagVariant = 'primary' | 'secondary' | 'success' | 'warning' | 'error'

export type TagProps = {
  /** Size preset */
  size?: TagSize
  /** Label text */
  label?: string
  /** Icon name from UniIcon registry */
  icon?: UniIconName
  /** Color variant */
  variant?: TagVariant
  /** Test ID for e2e testing */
  testID?: string
}

/**
 * Tag component for displaying compact labels.
 *
 * @example
 * ```tsx
 * <Tag label="New" variant="primary" />
 * <Tag label="Warning" variant="warning" icon="alert" />
 * <Tag label="Small" size="sm" />
 * ```
 */
export const Tag = ({icon, size = 'md', label = '', variant = 'primary', testID}: TagProps) => {
  styles.useVariants({
    fontColor: variant,
    size,
  })

  return (
    <View style={styles.container} testID={testID}>
      <ChamferBackground size="auto" fillToken={variantSurfaceToken[variant]} />
      {icon ? (
        <UniIcon name={icon} size="xs" uniProps={(theme) => ({color: theme.colors[variantTextToken[variant]]})} />
      ) : null}
      <Typography variant="bodySm_regular" style={styles.typography}>
        {label}
      </Typography>
    </View>
  )
}

// Single source for the per-variant foreground: the icon must match the label,
// so both the Typography variants and the UniIcon tint read this map.
const variantTextToken = {
  primary: 'primaryInverse',
  secondary: 'textDefault',
  success: 'successDefault',
  warning: 'textDefault',
  error: 'errorDefault',
} as const satisfies Record<TagVariant, keyof NewColorTokens>

/** Per-variant surface, painted onto the chamfer rather than set as a background. */
const variantSurfaceToken = {
  primary: 'primaryDefault',
  secondary: 'primaryMuted',
  success: 'successMuted',
  warning: 'warningMuted',
  error: 'errorMuted',
} as const satisfies Record<TagVariant, keyof NewColorTokens>

const styles = StyleSheet.create(({colors, spacing}) => ({
  typography: {
    variants: {
      fontColor: {
        true: {color: colors.textDefault},
        primary: {color: colors[variantTextToken.primary]},
        secondary: {color: colors[variantTextToken.secondary]},
        success: {color: colors[variantTextToken.success]},
        warning: {color: colors[variantTextToken.warning]},
        error: {color: colors[variantTextToken.error]},
        default: {color: colors.textDefault},
      },
    },
  },
  container: {
    justifyContent: 'center',
    alignItems: 'center',
    alignSelf: 'flex-start',
    paddingHorizontal: spacing.spacing8,
    gap: spacing.spacing4,
    flexDirection: 'row',
    variants: {
      size: {
        sm: {height: 20},
        md: {height: 24, paddingVertical: spacing.spacing2},
      },
    },
  },
}))
