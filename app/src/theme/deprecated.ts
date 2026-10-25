/**
 * Backward compatibility layer for gradual theme migration.
 *
 * This module provides a compatibility shim that allows existing components
 * to continue using old token names while we migrate to the new structure.
 *
 * Usage: Import themes from here instead of directly from presets during migration.
 *
 * @deprecated Use new token names from presets directly
 * @module
 */

import {accentNames} from './accent-ramps'
import {pnyxPalette} from './palette'
import {pnyxDarkFor, pnyxLightFor} from './presets/pnyx'
import {themeNameFor} from './theme-names'
import type {BaseTheme, LegacyColorTokens, LegacyRadius, LegacySpacing, LegacyTypography, Theme} from './tokens'

/**
 * Re-export Theme as CompatTheme for backward compatibility.
 * This is the complete theme type with both old and new tokens.
 */
export type CompatTheme = Theme

/**
 * Creates legacy color tokens from new tokens.
 */
const createLegacyColors = (newColors: BaseTheme['colors']): LegacyColorTokens => ({
  primary: newColors.primaryDefault,
  primaryForeground: newColors.primaryInverse,
  secondary: newColors.secondaryDefault,
  accent: newColors.secondaryDefault,
  background: newColors.backgroundDefault,
  surface: newColors.backgroundAlternative,
  surfaceHover: newColors.backgroundAlternativeHover,
  text: newColors.textDefault,
  textSecondary: newColors.textAlternative,
  error: newColors.errorDefault,
  success: newColors.successDefault,
  warning: newColors.warningDefault,
  info: newColors.infoDefault,
  border: newColors.borderDefaultStrong,
  disabled: newColors.textMuted,
  white: pnyxPalette.white,
  black: pnyxPalette.black,
})

/**
 * Creates legacy spacing from new spacing.
 */
const createLegacySpacing = (newSpacing: BaseTheme['spacing']): LegacySpacing => ({
  0: 0,
  1: newSpacing.spacing4,
  2: newSpacing.spacing8,
  3: newSpacing.spacing12,
  4: newSpacing.spacing16,
  5: newSpacing.spacing20,
  6: newSpacing.spacing24,
  8: newSpacing.spacing32,
  10: newSpacing.spacing40,
  12: newSpacing.spacing48,
  16: newSpacing.spacing80, // Best approximation
  20: newSpacing.spacing80,
  24: newSpacing.spacing104, // Best approximation
  32: newSpacing.spacing160, // Best approximation
})

/**
 * Creates legacy radius from new radius.
 */
const createLegacyRadius = (newRadius: BaseTheme['borderRadius']): LegacyRadius => ({
  none: newRadius.none,
  sm: newRadius.rounded4,
  md: newRadius.rounded8,
  lg: newRadius.rounded12,
  xl: newRadius.rounded16,
  full: newRadius.roundedCircle,
})

/**
 * Creates legacy typography from new theme.
 */
const createLegacyTypography = (newTheme: BaseTheme): LegacyTypography => ({
  fontFamily: newTheme.fontFamily.regular,
  monoFontFamily: 'monospace', // Fixed value
  fontSize: {
    xs: newTheme.fontSizes.bodySm,
    sm: newTheme.fontSizes.bodyMd,
    md: newTheme.fontSizes.bodyLg,
    lg: newTheme.fontSizes.headingSm,
    xl: newTheme.fontSizes.headingMd,
    '2xl': newTheme.fontSizes.headingLg,
    '3xl': newTheme.fontSizes.displaySm,
    '4xl': newTheme.fontSizes.displayMd,
  },
  fontWeight: {
    light: '300',
    regular: '400',
    medium: '500',
    semibold: '600',
    bold: '700',
  },
  lineHeight: {
    tight: 1.25,
    normal: 1.5,
    relaxed: 1.75,
  },
})

/**
 * Gap helper function.
 */
const gap = (multiplier: number): number => multiplier * 8

/**
 * Wraps a base theme with backward compatibility layer.
 * Converts BaseTheme (new structure) to Theme (with legacy tokens).
 */
const wrapTheme = (baseTheme: BaseTheme): Theme => {
  const legacyColors = createLegacyColors(baseTheme.colors)
  const legacySpacing = createLegacySpacing(baseTheme.spacing)

  return {
    ...baseTheme,
    colors: {
      ...baseTheme.colors,
      ...legacyColors,
    },
    // Add legacy spacing keys alongside new ones
    spacing: {
      ...baseTheme.spacing,
      ...legacySpacing,
    },
    typography: createLegacyTypography(baseTheme),
    radius: createLegacyRadius(baseTheme.borderRadius),
    gap,
  } as Theme
}

/**
 * Pnyx light theme with backward compatibility — the default violet scheme.
 */
export const pnyxLight: Theme = wrapTheme(pnyxLightFor('violet'))

/**
 * Pnyx dark theme with backward compatibility — the default violet scheme.
 */
export const pnyxDark: Theme = wrapTheme(pnyxDarkFor('violet'))

/**
 * All themes with backward compatibility. These are the themes registered with Unistyles.
 *
 * ⚠️ **Two per scheme, and the mode is part of the name.** Unistyles switches by name, so the
 * palette and light/dark axes have to be pre-multiplied into one registry — `themeNameFor` is the
 * only place that spelling is decided. The legacy `pnyxLight` / `pnyxDark` keys stay because they
 * are what `configureUnistyles` names as the initial theme.
 */
export {themeNameFor} from './theme-names'

export const themes = {
  pnyxLight,
  pnyxDark,
  ...(Object.fromEntries(
    accentNames.flatMap((accent) => [
      [themeNameFor(accent, false), wrapTheme(pnyxLightFor(accent))],
      [themeNameFor(accent, true), wrapTheme(pnyxDarkFor(accent))],
    ]),
  ) as Record<string, Theme>),
} as const
