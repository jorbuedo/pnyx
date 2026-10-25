/**
 * Static theme values shared across all brands.
 *
 * These tokens are brand-agnostic and provide the structural foundation
 * for spacing, sizing, typography variants, and animations.
 *
 * @module
 */

import {platformIsIOS} from '../platform'

/**
 * Font weight values as string literals for React Native.
 */
export const fontWeights = {
  light: '300',
  regular: '400',
  medium: '500',
  semiBold: '600',
  bold: '700',
  extraBold: '800',
} as const

/**
 * Pnyx brand font family configuration.
 * Uses Inter — Regular / Medium / SemiBold / Bold.
 *
 * Weight mapping:
 * - Bold   → headings, hero text, feature callouts
 * - Regular → body text, subheadings, navigation
 * - Medium  → buttons, labels, emphasis
 */
export const pnyxFontFamily = {
  light: 'Inter-Regular', // No light variant bundled, fallback to regular
  regular: 'Inter-Regular',
  medium: 'Inter-Medium',
  semiBold: 'Inter-SemiBold',
  bold: 'Inter-Bold',
  extraBold: 'Inter-Bold', // No extra bold bundled, fallback to bold
} as const

/**
 * Font sizes in pixels.
 * Follows Material Design 3 type scale naming.
 */
export const fontSizes = {
  bodyXs: 10,
  bodySm: 12,
  bodyMd: 14,
  bodyLg: 16,
  headingSm: 16,
  headingMd: 18,
  headingLg: 20,
  headingXl: 24,
  displayXs: 26,
  displaySm: 32,
  displayMd: 34,
  displayLg: 56,
  displayXl: 58,
} as const

/**
 * Line heights in pixels.
 * Paired with font sizes for readable typography.
 */
export const lineHeights = {
  bodyXs: 16,
  bodySm: 20,
  bodyMd: 22,
  bodyLg: 24,
  headingSm: 24,
  headingMd: 24,
  headingLg: 32,
  headingXl: 32,
  displayXs: 32,
  displaySm: 40,
  displayMd: 40,
  displayLg: 66,
  displayXl: 70,
} as const

/**
 * Spacing tokens in pixels.
 * Named by their pixel values for clarity.
 */
export const spacing = {
  spacing2: 2,
  spacing4: 4,
  spacing6: 6,
  spacing8: 8,
  spacing12: 12,
  spacing16: 16,
  spacing20: 20,
  spacing24: 24,
  spacing32: 32,
  spacing40: 40,
  spacing48: 48,
  spacing56: 56,
  spacing80: 80,
  spacing104: 104,
  spacing120: 120,
  spacing160: 160,
} as const

/**
 * Border radius tokens in pixels.
 * Named by their pixel values with roundedCircle for full rounding.
 */
export const borderRadius = {
  none: 0,
  rounded4: 4,
  rounded8: 8,
  rounded12: 12,
  rounded16: 16,
  rounded20: 20,
  rounded24: 24,
  rounded32: 32,
  roundedCircle: 999999,
} as const

/**
 * Chamfer cut lengths in pixels — the bevelled-corner counterpart to `borderRadius`.
 *
 * `cut` values pair with a `borderRadius` of the same magnitude so a surface can be
 * switched between rounded and chamfered without relaying out.
 */
export const chamfer = {
  none: 0,
  cut4: 4,
  cut6: 6,
  cut8: 8,
  cut10: 10,
  cut12: 12,
  cut14: 14,
  cut16: 16,
  cut20: 20,
} as const

/**
 * Border width tokens in pixels.
 */
export const borderWidth = {
  s: 1,
  m: 2,
  l: 4,
} as const

/**
 * Icon size tokens in pixels.
 */
export const iconSizes = {
  xs: 12,
  s: 16,
  sm: 20,
  m: 24,
  l: 32,
  xl: 40,
  xxl: 48,
} as const

/**
 * Button height tokens in pixels.
 */
export const buttonSizes = {
  s: 32,
  sm: 40,
  m: 48,
  l: 56,
} as const

/**
 * Row height tokens in pixels.
 * For list items and row components.
 */
export const rowSizes = {
  s: 56,
  m: 64,
  l: 72,
} as const

/**
 * Input height tokens in pixels.
 */
export const inputSizes = {
  s: 36,
  m: 48,
  l: 56,
} as const

/**
 * Letter spacing tokens in pixels.
 */
export const letterSpacing = {
  none: 0,
  xs: 0.25,
} as const

/**
 * Grid column count tokens.
 * Use these to define responsive grid layouts.
 */
export const gridColumns = {
  c1: 1,
  c2: 2,
  c4: 4,
  c6: 6,
  c12: 12,
  c24: 24,
} as const

/**
 * Font family configuration shape.
 * All brand font families must satisfy this structure.
 */
export type FontFamilyConfig = {
  readonly light: string
  readonly regular: string
  readonly medium: string
  readonly semiBold: string
  readonly bold: string
  readonly extraBold: string
}

/**
 * Creates text variant definitions for a given font family.
 * Each variant combines fontSize, lineHeight, fontFamily, and optional letterSpacing.
 */
export const createTextVariants = (fontFamily: FontFamilyConfig) =>
  ({
    displayXl: {
      fontSize: fontSizes.displayXl,
      lineHeight: lineHeights.displayXl,
      fontFamily: fontFamily.extraBold,
      fontWeight: '700' as const,
      letterSpacing: letterSpacing.none,
    },
    displayLg: {
      fontSize: fontSizes.displayLg,
      lineHeight: lineHeights.displayLg,
      fontFamily: fontFamily.extraBold,
      fontWeight: '700' as const,
      letterSpacing: letterSpacing.none,
    },
    displayMd: {
      fontSize: fontSizes.displayMd,
      lineHeight: lineHeights.displayMd,
      fontFamily: fontFamily.extraBold,
      fontWeight: '700' as const,
      letterSpacing: letterSpacing.none,
    },
    displayXs: {
      fontSize: fontSizes.displayXs,
      lineHeight: lineHeights.displayXs,
      fontFamily: fontFamily.extraBold,
      fontWeight: '700' as const,
      letterSpacing: letterSpacing.none,
    },
    displaySm: {
      fontSize: fontSizes.displaySm,
      lineHeight: lineHeights.displaySm,
      fontFamily: fontFamily.extraBold,
      fontWeight: '700' as const,
      letterSpacing: letterSpacing.none,
    },
    headingLg: {
      fontSize: fontSizes.headingLg,
      lineHeight: lineHeights.headingLg,
      fontFamily: fontFamily.bold,
      fontWeight: '700' as const,
      letterSpacing: letterSpacing.none,
    },
    headingMd: {
      fontSize: fontSizes.headingMd,
      lineHeight: lineHeights.headingMd,
      fontFamily: fontFamily.bold,
      fontWeight: '700' as const,
      letterSpacing: letterSpacing.none,
    },
    headingMd_semibold: {
      fontSize: fontSizes.headingMd,
      lineHeight: lineHeights.headingMd,
      fontFamily: fontFamily.semiBold,
      fontWeight: '600' as const,
      letterSpacing: letterSpacing.none,
    },
    headingSm: {
      fontSize: fontSizes.headingSm,
      lineHeight: lineHeights.headingSm,
      fontFamily: fontFamily.bold,
      fontWeight: '700' as const,
      letterSpacing: letterSpacing.none,
    },
    headingXl: {
      fontSize: fontSizes.headingXl,
      lineHeight: lineHeights.headingXl,
      fontFamily: fontFamily.bold,
      fontWeight: '700' as const,
      letterSpacing: letterSpacing.none,
    },
    bodyLg_semibold: {
      fontSize: fontSizes.bodyLg,
      lineHeight: lineHeights.bodyLg,
      fontFamily: fontFamily.semiBold,
      fontWeight: '600' as const,
      letterSpacing: letterSpacing.none,
    },
    bodyLg_medium: {
      fontSize: fontSizes.bodyLg,
      lineHeight: lineHeights.bodyLg,
      fontFamily: fontFamily.medium,
      fontWeight: '500' as const,
      letterSpacing: letterSpacing.none,
    },
    bodyLg_regular: {
      fontSize: fontSizes.bodyLg,
      lineHeight: lineHeights.bodyLg,
      fontFamily: fontFamily.regular,
      fontWeight: '400' as const,
      letterSpacing: letterSpacing.none,
    },
    bodyMd_bold: {
      fontSize: fontSizes.bodyMd,
      lineHeight: lineHeights.bodyMd,
      fontFamily: fontFamily.bold,
      fontWeight: '700' as const,
      letterSpacing: letterSpacing.none,
    },
    bodyMd_medium: {
      fontSize: fontSizes.bodyMd,
      lineHeight: lineHeights.bodyMd,
      fontFamily: fontFamily.medium,
      fontWeight: '500' as const,
      letterSpacing: letterSpacing.none,
    },
    bodyMd_regular: {
      fontSize: fontSizes.bodyMd,
      lineHeight: lineHeights.bodyMd,
      fontFamily: fontFamily.regular,
      fontWeight: '400' as const,
      letterSpacing: letterSpacing.none,
    },
    bodySm_bold: {
      fontSize: fontSizes.bodySm,
      lineHeight: lineHeights.bodySm,
      fontFamily: fontFamily.bold,
      fontWeight: '700' as const,
      letterSpacing: letterSpacing.none,
    },
    bodySm_medium: {
      fontSize: fontSizes.bodySm,
      lineHeight: lineHeights.bodySm,
      fontFamily: fontFamily.medium,
      letterSpacing: letterSpacing.xs,
      fontWeight: '500' as const,
    },
    bodySm_regular: {
      fontSize: fontSizes.bodySm,
      lineHeight: lineHeights.bodySm,
      fontFamily: fontFamily.regular,
      fontWeight: '400' as const,
      letterSpacing: letterSpacing.none,
    },
    bodyXs_medium: {
      fontSize: fontSizes.bodyXs,
      lineHeight: lineHeights.bodyXs,
      fontFamily: fontFamily.medium,
      fontWeight: '500' as const,
      letterSpacing: letterSpacing.xs,
    },
    bodyXs_regular: {
      fontSize: fontSizes.bodyXs,
      lineHeight: lineHeights.bodyXs,
      fontFamily: fontFamily.regular,
      fontWeight: '400' as const,
      letterSpacing: letterSpacing.xs,
    },
  }) as const

/**
 * Animation configuration presets.
 * Spring animations for natural feel, timing for precise control.
 */
export const animations = {
  fast: {
    type: 'spring' as const,
    damping: 20,
    mass: 1.2,
    stiffness: 250,
  },
  medium: {
    type: 'spring' as const,
    damping: 10,
    mass: 0.9,
    stiffness: 100,
  },
  slow: {
    type: 'spring' as const,
    damping: 20,
    stiffness: 60,
  },
  lazy: {
    type: 'spring' as const,
    damping: 18,
    stiffness: 50,
  },
  '100ms': {
    type: 'timing' as const,
    duration: 100,
  },
  '300ms': {
    type: 'timing' as const,
    duration: 300,
  },
  tabs: {
    type: 'spring' as const,
    stiffness: 100,
    damping: 15,
    mass: 1,
  },
} as const

/**
 * Opacity levels for various UI states.
 */
export const opacity = {
  none: 1,
  low: 0.8,
  medium: 0.6,
  high: 0.38,
  highest: 0.12,
} as const

/**
 * Hex alpha values for color manipulation.
 * Append to hex colors for transparency.
 */
export const colorAlpha = {
  100: 'FF',
  80: 'CC',
  60: '99',
  38: '61',
  24: '3D',
  12: '1F',
  6: '06',
  0: '00',
} as const

/**
 * Platform-specific and fixed UI sizes.
 */
export const otherSizes = {
  tabBarHeight: 72,
  bottomTabbarHeight: 60,
  headerHeight: platformIsIOS ? 44 : 56,
  activeIndicatorSize: 6,
} as const

/**
 * Base static theme object with all non-color tokens.
 * Spread this into brand-specific themes.
 */
export const baseStaticTheme = {
  spacing,
  borderRadius,
  chamfer,
  borderWidth,
  iconSizes,
  buttonSizes,
  rowSizes,
  inputSizes,
  fontWeights,
  fontSizes,
  lineHeights,
  letterSpacing,
  gridColumns,
  animations,
  opacity,
  colorAlpha,
  otherSizes,
} as const

export type Spacing = typeof spacing
export type BorderRadius = typeof borderRadius
export type Chamfer = typeof chamfer
export type BorderWidth = typeof borderWidth
export type IconSizes = typeof iconSizes
export type ButtonSizes = typeof buttonSizes
export type RowSizes = typeof rowSizes
export type InputSizes = typeof inputSizes
export type FontWeights = typeof fontWeights
export type FontSizes = typeof fontSizes
export type LineHeights = typeof lineHeights
export type LetterSpacing = typeof letterSpacing
export type GridColumns = typeof gridColumns
export type Animations = typeof animations
export type Opacity = typeof opacity
export type ColorAlpha = typeof colorAlpha
export type OtherSizes = typeof otherSizes
export type FontWeightValue = '100' | '200' | '300' | '400' | '500' | '600' | '700' | '800' | '900' | 'normal' | 'bold'
export type TextVariant = {
  fontSize: number
  lineHeight: number
  fontFamily: string
  fontWeight: FontWeightValue
  letterSpacing?: number
}
export type TextVariants = ReturnType<typeof createTextVariants>
