/**
 * ButtonIcon component.
 *
 * An icon-only button with multiple size and style variants.
 *
 * @module
 */

import {useState} from 'react'
import type {GestureResponderEvent, Insets, ViewProps} from 'react-native'
import {Pressable} from 'react-native'
import {StyleSheet, useUnistyles} from 'react-native-unistyles'
import type {NewColorTokens} from '../../theme/tokens'
import {ChamferBackground, chamferedSurfaceStyle} from '../Chamfer'
import {CircleLoader, type CircleLoaderProps} from '../Loaders/CircleLoader'
import type {UniIconProps} from '../UniIcon'
import {type IconProp, renderIcon} from './Button'
import {type ButtonIconVariant, buttonIconFill, buttonIconIsPainted} from './button-icon-surface'

/** Available button icon sizes */
export type ButtonIconSize = 'xxs' | 'xs' | 'sm' | 'md' | 'lg'

export type {ButtonIconVariant}

type Size = {width: number; height: number}

/** Maps size preset to container dimensions */
const mapSizeToSize: Record<ButtonIconSize, Size> = {
  lg: {width: 36, height: 36},
  md: {width: 28, height: 28},
  sm: {width: 24, height: 24},
  xs: {width: 20, height: 20},
  xxs: {width: 16, height: 16},
}

/** Maps size preset to default icon dimensions */
const mapSizeToDefaultIconSize: Record<ButtonIconSize, Size> = {
  lg: {width: 32, height: 32},
  md: {width: 24, height: 24},
  sm: {width: 20, height: 20},
  xs: {width: 18, height: 18},
  xxs: {width: 16, height: 16},
}

/** Maps size to UniIcon size prop */
const mapSizeToIconSize: Record<ButtonIconSize, 'lg' | 'md' | 'sm' | 'xs'> = {
  lg: 'lg',
  md: 'md',
  sm: 'sm',
  xs: 'xs',
  xxs: 'xs', // xxs maps to xs for icon
}

const mapVariantToIconColor: Record<ButtonIconVariant, keyof NewColorTokens> = {
  primary: 'primaryInverse',
  naked: 'iconDefault',
  alternativeNaked: 'iconAlternative',
  errorNaked: 'primaryInverse',
  invertedNaked: 'primaryInverse',
  overlayDark: 'btnIconOverlayDarkIcon',
  overlayLight: 'btnIconOverlayLightIcon',
  subtleCircular: 'iconDefault',
}

const mapVariantToDefaultIconSize: Record<ButtonIconVariant, Size | null> = {
  primary: null,
  naked: null,
  alternativeNaked: null,
  errorNaked: null,
  invertedNaked: null,
  overlayDark: null,
  overlayLight: null,
  subtleCircular: {width: 12, height: 12},
}

export type ButtonIconProps = {
  /** Press handler */
  onPress?: (() => void) | undefined
  /** Button size preset */
  size?: ButtonIconSize | undefined
  /** Whether the button is disabled */
  isDisabled?: boolean | undefined
  /** Props to pass to the icon */
  iconProps?: Omit<UniIconProps, 'name'> | undefined
  /** Whether to show loading spinner */
  isLoading?: boolean | undefined
  /** Visual style variant */
  variant?: ButtonIconVariant | undefined
  /** Icon to display */
  icon?: IconProp | undefined
  /** Custom width override */
  width?: number | undefined
  /** Custom height override */
  height?: number | undefined
  /** Touch target expansion */
  hitSlop?: Insets | undefined
  /** Props to pass to the loader */
  loaderProps?: CircleLoaderProps | undefined
  /** Whether to disable focus */
  noFocus?: boolean | undefined
  /** Whether to allow event propagation */
  allowEventPropagation?: boolean | undefined
  /**
   * Props forwarded to the pressable — accessibility, mostly. `style` is not
   * among them: the box is painted, so its corner and fill come from `variant`.
   */
  containerProps?: Omit<ViewProps, 'style'> | undefined
  /** Test ID for e2e testing */
  testID?: string | undefined
}

/**
 * Calculates hit slop to ensure minimum touch target size.
 */
const getHitSlop = (dimensions: number): Insets => {
  const MAX_SIZE_TOUCH_AREA = 40
  const hitSlop = (MAX_SIZE_TOUCH_AREA - dimensions) / 2

  return {
    top: hitSlop,
    bottom: hitSlop,
    left: hitSlop,
    right: hitSlop,
  }
}

/**
 * ButtonIcon component.
 *
 * A compact icon button for actions that don't need a label.
 *
 * @example
 * ```tsx
 * // Basic icon button
 * <ButtonIcon icon="close" onPress={handleClose} />
 *
 * // With variant
 * <ButtonIcon icon="settings" variant="primary" onPress={openSettings} />
 *
 * // Loading state
 * <ButtonIcon icon="refresh" isLoading onPress={handleRefresh} />
 * ```
 */
export const ButtonIcon = ({
  onPress,
  icon,
  iconProps,
  width,
  height,
  size = 'md',
  variant = 'naked',
  isDisabled = false,
  isLoading = false,
  loaderProps = {},
  hitSlop,
  noFocus,
  allowEventPropagation = false,
  containerProps = {},
  testID,
}: ButtonIconProps) => {
  const {theme} = useUnistyles()
  styles.useVariants({size, variant})
  // A painted press fill has to be readable at render time — Pressable's style
  // callback can only reach the box, and a background there would square the cut.
  const [isPressed, setIsPressed] = useState(false)

  const handlePress = (e: GestureResponderEvent): void => {
    if (isLoading || isDisabled) return
    if (!allowEventPropagation) e.stopPropagation()
    e.preventDefault()
    onPress?.()
  }

  const calculatedHitSlopFromSize = getHitSlop(width ?? mapSizeToSize[size].width)

  const isPrimary = variant === 'primary'
  const hitSlopProp = isPrimary ? undefined : calculatedHitSlopFromSize

  const iconColor = theme.colors[mapVariantToIconColor[variant]]
  const isInteractive = !isDisabled && !isLoading
  const isPainted = buttonIconIsPainted(variant)
  const fillToken = buttonIconFill(variant, isInteractive && isPressed)

  const boxStyle = (pressed: boolean) => {
    const box = [styles.container(isPrimary, width, height, isDisabled), isInteractive && pressed && styles.dimmed]

    return isPainted ? chamferedSurfaceStyle(...box) : box
  }

  return (
    <Pressable
      onPress={handlePress}
      disabled={isDisabled}
      hitSlop={hitSlop ?? hitSlopProp}
      onPressIn={() => setIsPressed(true)}
      onPressOut={() => setIsPressed(false)}
      style={({pressed}) => boxStyle(pressed)}
      focusable={!noFocus && !isDisabled}
      testID={testID}
      {...containerProps}
    >
      {fillToken && <ChamferBackground size="auto" fillToken={fillToken} />}
      {isLoading ? (
        <CircleLoader size="sm" color={iconColor} {...loaderProps} />
      ) : (
        renderIcon(icon, {
          ...(mapVariantToDefaultIconSize[variant] ?? mapSizeToDefaultIconSize[size]),
          color: iconProps?.color ?? iconColor,
          size: (iconProps?.size ?? mapSizeToIconSize[size]) as 'lg' | 'md' | 'sm' | 'xs',
        })
      )}
    </Pressable>
  )
}

const styles = StyleSheet.create(({spacing, borderRadius, colors}) => ({
  container: (isPrimary: boolean, width?: number, height?: number, isDisabled?: boolean) => ({
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    padding: spacing.spacing2,
    opacity: isDisabled ? 0.4 : 1,
    width: width ?? (isPrimary ? 40 : undefined),
    height: height ?? (isPrimary ? 40 : undefined),
    variants: {
      size: {
        lg: {width: 36, height: 36},
        md: {width: 28, height: 28},
        sm: {width: 24, height: 24},
        xs: {width: 20, height: 20, padding: 0},
        xxs: {width: 16, height: 16, padding: 0},
      },
      variant: {
        primary: {},
        naked: {backgroundColor: 'transparent'},
        alternativeNaked: {backgroundColor: 'transparent'},
        errorNaked: {backgroundColor: 'transparent'},
        invertedNaked: {backgroundColor: 'transparent'},
        overlayDark: {},
        overlayLight: {},
        // Subtle circular surface used by bottom-sheet headers (e.g. limits
        // edit view) — 32px circle with elevated bg and
        // 1px subtle border. Inherits the size preset's width/height, just
        // overrides the corner radius + adds the border.
        subtleCircular: {
          backgroundColor: colors.backgroundAlternativeHover,
          borderRadius: borderRadius.roundedCircle,
          borderWidth: 1,
          borderColor: colors.borderDefaultWeak,
        },
      },
    },
  }),
  // Press colour comes from the painted fill (`buttonIconSurfaces`), never from a
  // background here — that would draw a square behind the cut corners.
  dimmed: {
    opacity: 0.5,
  },
}))
