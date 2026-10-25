/**
 * Button component.
 *
 * A versatile button with multiple variants, sizes, icons, and loading states.
 *
 * @module
 */

import type {ReactNode} from 'react'
import {useEffect, useState} from 'react'
import type {ViewStyle} from 'react-native'
import {Pressable, View} from 'react-native'
import {useSharedValue} from 'react-native-reanimated'
import {StyleSheet, useUnistyles} from 'react-native-unistyles'

import {platformIsWeb} from '../../platform'
import type {NewColorTokens} from '../../theme/tokens'
import {ChamferBackground, type ChamferPaintProps, chamferedSurfaceStyle} from '../Chamfer'
import {CircleLoader} from '../Loaders/CircleLoader'
import {SkeletonBase} from '../Loaders/Skeleton/SkeletonBase'
import {Typography} from '../Typography'
import {UniIcon, type UniIconName, type UniIconProps} from '../UniIcon'

const FOCUS_BORDER_WIDTH = 2

/** Available button sizes */
export type ButtonSize = 'lg' | 'xl' | 'md' | 'sm' | 'xs' | 'auto'

/** Variants a caller may pass. Error styling comes from `isError`, never from the name. */
export type ButtonBaseVariant = 'primary' | 'secondary' | 'nakedDefault'

/** Every resolved variant — each base plus its error form. */
export type ButtonVariant = ButtonBaseVariant | `${ButtonBaseVariant}Error`

/** Icon prop type - can be a string icon name or a React element */
export type IconProp = ReactNode | UniIconName | undefined

export type ButtonLoadingPresentation = 'spinner' | 'skeleton'

export type ButtonProps = {
  /** Press handler */
  onPress?: (() => void) | undefined
  /** Button size preset */
  size?: ButtonSize | undefined
  /** Visual style variant. Error styling is applied via `isError`, not by name. */
  variant?: ButtonBaseVariant | undefined
  /** Whether the button is disabled */
  isDisabled?: boolean | undefined
  /** @deprecated Use isDisabled instead */
  disabled?: boolean | undefined
  /** Button label text */
  label?: string | undefined
  /** Left side icon */
  leftIcon?: IconProp | undefined
  /** Right side icon */
  rightIcon?: IconProp | undefined
  /** Props to pass to icons */
  iconProps?: Omit<UniIconProps, 'name'> | undefined
  /** Whether the button should fill available width */
  fullWidth?: boolean | undefined
  /** Whether to show loading spinner */
  isLoading?: boolean | undefined
  /** Loading indicator style. Defaults to the app-wide spinner. */
  loadingPresentation?: ButtonLoadingPresentation | undefined
  /** @deprecated Use isLoading instead */
  loading?: boolean | undefined
  /** Whether this is an error state */
  isError?: boolean | undefined
  /**
   * Style for the outer wrapper — layout and spacing. The button's own box is
   * painted, so its corner, edge and fill come from `variant`, not from a style.
   */
  containerStyles?: ViewStyle | undefined
  /** @deprecated Use containerStyles instead */
  style?: ViewStyle | undefined
  /** Test ID for e2e testing */
  testID?: string | undefined
  /** Custom content rendered inside the button; replaces label + icons */
  children?: ReactNode | undefined
}

/** Maps variant to pressed background color */
const mapVariantToPressedBgColor: Record<ButtonVariant, keyof NewColorTokens> = {
  primary: 'primaryPressed',
  primaryError: 'errorPressed',
  secondary: 'backgroundAlternativePressed',
  secondaryError: 'backgroundAlternativePressed',
  nakedDefault: 'backgroundDefaultPressed',
  nakedDefaultError: 'backgroundDefaultPressed',
}

/** Maps variant to loader spinner color */
const mapVariantToCircleLoaderColor: Record<ButtonVariant, keyof NewColorTokens> = {
  primary: 'primaryInverse',
  primaryError: 'errorInverse',
  secondary: 'textDefault',
  secondaryError: 'errorDefault',
  nakedDefault: 'primaryAlternativeInverse',
  nakedDefaultError: 'errorDefault',
}

/** Resting fill painted onto the chamfer. `null` leaves the surface unpainted. */
const mapVariantToFillColor: Record<ButtonVariant, keyof NewColorTokens | null> = {
  primary: null, // gradient, not a flat fill
  primaryError: 'errorDefault',
  secondary: 'backgroundAlternative',
  secondaryError: null,
  nakedDefault: null,
  nakedDefaultError: null,
}

/** Hairline stroked along the chamfer, for the variants that carry an edge. */
const mapVariantToBorderColor: Record<ButtonVariant, keyof NewColorTokens | null> = {
  primary: null,
  primaryError: null,
  secondary: 'borderInteractive',
  secondaryError: 'errorBorder',
  nakedDefault: null,
  nakedDefaultError: null,
}

/** Maps variant to text color */
const mapVariantToTextColor: Record<ButtonVariant, keyof NewColorTokens> = {
  primary: 'primaryInverse',
  primaryError: 'errorInverse',
  secondary: 'textDefault',
  secondaryError: 'errorDefault',
  nakedDefault: 'primaryAlternativeInverse',
  nakedDefaultError: 'errorDefault',
}

/**
 * Renders an icon from either a string name or React element.
 */
export const renderIcon = (icon: IconProp, iconProps?: Omit<UniIconProps, 'name'>): ReactNode => {
  if (typeof icon === 'string') {
    return <UniIcon name={icon as UniIconName} {...iconProps} />
  }

  if (typeof icon === 'object') {
    return icon
  }

  return null
}

/**
 * Gets the full variant including error suffix if needed.
 */
const getVariant = (variant: ButtonBaseVariant, isError: boolean): ButtonVariant =>
  isError ? `${variant}Error` : variant

/**
 * Button component.
 *
 * A feature-rich button with icons, loading states, and many style variants.
 *
 * @example
 * ```tsx
 * // Primary button
 * <Button label="Submit" onPress={handleSubmit} />
 *
 * // With icons
 * <Button label="Next" rightIcon="arrowRight" onPress={handleNext} />
 *
 * // Loading state
 * <Button label="Saving" isLoading onPress={handleSave} />
 *
 * // Error variant
 * <Button label="Delete" variant="primary" isError onPress={handleDelete} />
 * ```
 */
export const Button = ({
  onPress,
  leftIcon,
  rightIcon,
  iconProps,
  size = 'md',
  variant = 'primary',
  label = '',
  isDisabled = false,
  disabled = false,
  fullWidth = false,
  isLoading = false,
  loadingPresentation = 'spinner',
  loading = false,
  isError = false,
  containerStyles,
  style,
  testID,
  children,
}: ButtonProps) => {
  const {theme} = useUnistyles()
  const [isFocused, setIsFocused] = useState(false)
  const [isHovered, setIsHovered] = useState(false)
  const [isPressed, setIsPressed] = useState(false)

  // Handle legacy props
  const effectiveDisabled = isDisabled || disabled
  const effectiveLoading = isLoading || loading

  useEffect(() => {
    if (effectiveDisabled) {
      setIsFocused(false)
      setIsHovered(false)
      setIsPressed(false)
    }
  }, [effectiveDisabled])
  const effectiveContainerStyles = containerStyles ?? style

  const _variant = getVariant(variant, isError)
  styles.useVariants({size} as Parameters<typeof styles.useVariants>[0])
  const isNakedVariant = _variant.startsWith('naked')
  const isPrimaryGradient = _variant === 'primary'

  const loaderColor = theme.colors[mapVariantToCircleLoaderColor[_variant]]
  const textColor = theme.colors[mapVariantToTextColor[_variant]]

  const handledIconProps = {
    size: 'xs' as const,
    color: textColor,
    ...iconProps,
  }

  const containerBox = useSharedValue({width: 0, height: 0})

  // `auto` is the link-style button: underlined text, no box, so nothing to chamfer.
  const isPainted = size !== 'auto'
  // Press feedback is a fill swap for the solid variants; naked and outline-critical
  // dim instead, so they must not drive the painted fill.
  const pressSwapsFill = isPainted && !isPrimaryGradient && !isNakedVariant && _variant !== 'secondaryError'

  const restingToken = mapVariantToFillColor[_variant]
  const borderToken = mapVariantToBorderColor[_variant]
  // The gradient stops stay resolved colours: an SVG `Stop` is a virtual element
  // with no style of its own, so Unistyles cannot bind a token to it — every
  // gradient renders black if you try. Flat fills go through tokens.
  const gradientStops = isPressed
    ? ([theme.colors.btnPrimaryGradientStartPressed, theme.colors.btnPrimaryGradientEndPressed] as const)
    : isHovered
      ? ([theme.colors.btnPrimaryGradientStartHover, theme.colors.btnPrimaryGradientEndHover] as const)
      : ([theme.colors.btnPrimaryGradientStart, theme.colors.btnPrimaryGradientEnd] as const)
  const paintFill: Pick<ChamferPaintProps, 'fill' | 'fillToken'> = isPrimaryGradient
    ? {fill: gradientStops}
    : pressSwapsFill && isPressed
      ? {fillToken: mapVariantToPressedBgColor[_variant]}
      : restingToken
        ? {fillToken: restingToken}
        : {}

  return (
    <View
      style={[styles.containerWrapper(fullWidth, size), effectiveContainerStyles as ViewStyle]}
      testID={testID}
      onLayout={(ev) => {
        containerBox.value = {
          width: ev.nativeEvent.layout.width,
          height: ev.nativeEvent.layout.height,
        }
      }}
    >
      <Pressable
        disabled={effectiveDisabled}
        onPress={onPress}
        onFocus={platformIsWeb ? () => setIsFocused(true) : undefined}
        onBlur={platformIsWeb ? () => setIsFocused(false) : undefined}
        onHoverIn={platformIsWeb && isPrimaryGradient ? () => setIsHovered(true) : undefined}
        onHoverOut={platformIsWeb && isPrimaryGradient ? () => setIsHovered(false) : undefined}
        onPressIn={isPrimaryGradient || pressSwapsFill ? () => setIsPressed(true) : undefined}
        onPressOut={isPrimaryGradient || pressSwapsFill ? () => setIsPressed(false) : undefined}
        style={({pressed}) =>
          chamferedSurfaceStyle(
            styles.container(effectiveDisabled),
            // `secondaryError` (outline-critical) and the naked variants have a
            // transparent resting fill, so a press fill would flash a card surface.
            // They dim instead; every other variant swaps its painted fill.
            pressed && (isNakedVariant || _variant === 'secondaryError') && {opacity: 0.5},
          )
        }
      >
        {isPainted && (paintFill.fillToken != null || paintFill.fill != null || borderToken != null) && (
          <ChamferBackground
            size="auto"
            {...paintFill}
            {...(borderToken ? {borderToken, borderWidth: 1} : {})}
            {...(isPrimaryGradient ? {sheen: isPressed || isHovered ? 0.16 : 0.25} : {})}
          />
        )}
        {isPainted && isFocused && (
          <ChamferBackground size="auto" borderToken="borderFocus" borderWidth={FOCUS_BORDER_WIDTH} />
        )}
        {effectiveLoading ? (
          loadingPresentation === 'skeleton' ? (
            <SkeletonBase
              show
              width={size === 'xs' || size === 'sm' ? 56 : 96}
              height={size === 'xs' || size === 'sm' ? 10 : 12}
              radius={size === 'xs' || size === 'sm' ? 5 : 6}
            />
          ) : (
            <CircleLoader size="sm" color={loaderColor} />
          )
        ) : children != null ? (
          children
        ) : (
          <>
            {renderIcon(leftIcon, handledIconProps)}
            {label ? (
              <Typography
                variant={
                  size === 'xs'
                    ? isPrimaryGradient
                      ? 'bodySm_bold'
                      : 'bodySm_medium'
                    : isPrimaryGradient
                      ? 'bodyMd_bold'
                      : 'bodyMd_medium'
                }
                style={[styles.labelStyle(textColor), size === 'auto' && styles.autoLabelStyle]}
              >
                {label}
              </Typography>
            ) : null}
            {renderIcon(rightIcon, handledIconProps)}
          </>
        )}
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create(({spacing}) => ({
  containerWrapper: (fullWidth: boolean, size: ButtonSize) => ({
    minWidth: size === 'auto' ? 0 : 75,
    width: fullWidth ? ('100%' as const) : ('auto' as const),
    alignSelf: fullWidth ? ('flex-start' as const) : ('auto' as const),
  }),
  container: (isDisabled: boolean) => ({
    opacity: isDisabled ? 0.3 : 1,
    position: 'relative' as const,
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    gap: spacing.spacing8,
    variants: {
      size: {
        xl: {height: 48, paddingHorizontal: spacing.spacing16},
        lg: {height: 42, paddingHorizontal: spacing.spacing16},
        md: {height: 36, paddingHorizontal: spacing.spacing16},
        sm: {height: 32, paddingHorizontal: spacing.spacing8},
        // Compact size for tight 3-up rows (e.g. staking details bottom bar).
        // Drives padding from content rather than a fixed height, so the
        // 12 px label can render without clipping (font-size 12px, padding 11px 6px).
        xs: {height: 'auto' as const, paddingVertical: 11, paddingHorizontal: spacing.spacing6},
        auto: {height: 'auto' as const, paddingHorizontal: 0},
      },
    },
  }),
  labelStyle: (textColor: string) => ({
    color: textColor,
  }),
  autoLabelStyle: {
    textDecorationLine: 'underline' as const,
  },
}))
