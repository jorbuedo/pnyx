/**
 * Theme configuration for the wallet app.
 *
 * This module provides the Unistyles configuration and all theme exports.
 * Import configureUnistyles and call it before any component that uses StyleSheet.
 *
 * @example
 * ```ts
 * // In your app's entry point (e.g., _layout.tsx)
 * import { configureUnistyles } from '@/theme'
 *
 * // Call before any imports that use StyleSheet
 * configureUnistyles('pnyxLight')
 *
 * // Or use adaptive themes (auto light/dark based on system)
 * configureUnistyles({ adaptiveThemes: true })
 * ```
 *
 * @module
 */

import {Platform} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {logger} from '../logger'
import {type Breakpoint, breakpoints} from './breakpoints'
// Use compatibility themes that include both old and new token names
import {type CompatTheme, pnyxDark, pnyxLight, themes} from './deprecated'

/**
 * All available themes for the application.
 *
 * These themes include both new token names (primaryDefault, backgroundDefault, etc.)
 * and deprecated legacy names (primary, background, etc.) for backward compatibility.
 *
 * Note: Do NOT add themes named 'light' and 'dark' - Unistyles will
 * automatically use them for adaptive theming based on OS preference,
 * which causes color leakage issues on web.
 */
export {themes}

export type AppThemeName = keyof typeof themes

// TypeScript type declarations for Unistyles autocomplete
type AppThemes = typeof themes
type AppBreakpoints = typeof breakpoints

declare module 'react-native-unistyles' {
  export interface UnistylesThemes extends AppThemes {}
  export interface UnistylesBreakpoints extends AppBreakpoints {}
}

/**
 * Configuration options for Unistyles.
 */
export type ConfigureUnistylesOptions =
  | AppThemeName
  | {
      /**
       * Initial theme to use.
       * Ignored if adaptiveThemes is true.
       * @default 'pnyxLight'
       */
      initialTheme?: AppThemeName
      /**
       * Enable adaptive themes that follow system light/dark mode.
       * Requires themes named 'light' and 'dark' to be defined.
       * @default false
       */
      adaptiveThemes?: boolean
    }

/**
 * Configure Unistyles with themes and breakpoints.
 *
 * IMPORTANT: This must be called before any component that uses StyleSheet
 * is imported or rendered.
 *
 * @param options - Initial theme name or configuration options
 */
export const configureUnistyles = (options?: ConfigureUnistylesOptions): void => {
  const settings =
    typeof options === 'string'
      ? {initialTheme: options}
      : (() => {
          const {initialTheme = 'pnyxLight', adaptiveThemes = false} = options ?? {}
          return adaptiveThemes ? ({adaptiveThemes: true} as const) : ({initialTheme} as const)
        })()
  const config = {themes, breakpoints, settings}

  // Unistyles' top-level `init()` (in its StyleSheet module) registers per-JSI-runtime
  // state. On iOS 26 / RN 0.81 that registration intermittently does not apply to the
  // runtime executing this configure, and `configure` then throws "not configured".
  // `createHybridObject` returns a fresh instance whose `init()` calls
  // `createState(rt)` for the *current* runtime — idempotent, safe to call defensively.
  // Skipped on web: nitro-modules has no web implementation and pulling it in there
  // triggers `__fbBatchedBridgeConfig` invariant at module-eval time.
  if (Platform.OS !== 'web') {
    try {
      const {NitroModules} = require('react-native-nitro-modules') as typeof import('react-native-nitro-modules')
      const fresh = NitroModules.createHybridObject<
        import('react-native-nitro-modules').HybridObject<{ios: 'c++'; android: 'c++'}> & {init: () => void}
      >('UnistylesStyleSheet')
      fresh.init()
    } catch (err) {
      // Nitro not registered on this runtime — fall through to plain configure.
      // Surface to Sentry: on native the module is expected to be linked, so
      // a throw here flags an actual init failure worth investigating.
      logger.error(err instanceof Error ? err : new Error(String(err)), {origin: 'theme'})
    }
  }

  StyleSheet.configure(config)
}

// Re-export breakpoints
export {breakpoints, type Breakpoint}

// Re-export compatibility themes (include both old and new token names)
export {pnyxDark, pnyxLight}
export type {CompatTheme}

export type {
  Animations,
  BorderRadius,
  BorderWidth,
  ButtonSizes,
  ColorAlpha,
  FontSizes,
  FontWeights,
  IconSizes,
  InputSizes,
  LineHeights,
  Opacity,
  OtherSizes,
  RowSizes,
  Spacing,
  TextVariant,
  TextVariants,
} from './base'

// Re-export base theme values
export {
  animations,
  baseStaticTheme,
  borderRadius,
  borderWidth,
  buttonSizes,
  colorAlpha,
  createTextVariants,
  type FontFamilyConfig,
  fontSizes,
  fontWeights,
  iconSizes,
  inputSizes,
  lineHeights,
  opacity,
  otherSizes,
  pnyxFontFamily,
  rowSizes,
  spacing,
} from './base'
// Shared navigation header style — keeps every stack/tab page title visually
// identical to the Earn tab header.
export {getSharedStackScreenOptions} from './navigation-header'
// Re-export palettes
export {hexToRgba, parseHexToRgb, pnyxPalette} from './palette'

// Re-export token types and deprecation maps
export type {
  BaseTheme,
  ColorTokens,
  LegacyColorTokens,
  LegacyRadius,
  LegacySpacing,
  LegacyTypography,
  NewColorTokens,
  Theme,
} from './tokens'
export {deprecatedColorMap, deprecatedRadiusMap, deprecatedSpacingMap} from './tokens'
export {useIsDark} from './use-is-dark'
