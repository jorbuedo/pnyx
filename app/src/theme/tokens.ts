import type {
  Animations,
  BorderRadius,
  BorderWidth,
  ButtonSizes,
  Chamfer,
  ColorAlpha,
  FontSizes,
  FontWeights,
  GridColumns,
  IconSizes,
  InputSizes,
  LetterSpacing,
  LineHeights,
  Opacity,
  OtherSizes,
  RowSizes,
  Spacing,
  TextVariants,
} from './base'

/**
 * Legacy color token names for backward compatibility.
 * @deprecated Use new semantic token names instead
 */
export type LegacyColorTokens = {
  /** @deprecated Use primaryDefault */
  readonly primary: string
  /** @deprecated Use primaryInverse */
  readonly primaryForeground: string
  /** @deprecated Use secondaryDefault */
  readonly secondary: string
  /** @deprecated Use secondaryDefault */
  readonly accent: string
  /** @deprecated Use backgroundDefault */
  readonly background: string
  /** @deprecated Use backgroundAlternative */
  readonly surface: string
  /** @deprecated Use backgroundAlternativeHover */
  readonly surfaceHover: string
  /** @deprecated Use textDefault */
  readonly text: string
  /** @deprecated Use textAlternative */
  readonly textSecondary: string
  /** @deprecated Use errorDefault */
  readonly error: string
  /** @deprecated Use successDefault */
  readonly success: string
  /** @deprecated Use warningDefault */
  readonly warning: string
  /** @deprecated Use infoDefault */
  readonly info: string
  /** @deprecated Use borderDefaultStrong */
  readonly border: string
  /** @deprecated Use textMuted */
  readonly disabled: string
  /** @deprecated Use primaryInverse or context-appropriate token */
  readonly white: string
  /** @deprecated Use primaryDefault or context-appropriate token */
  readonly black: string
}

/**
 * New semantic color tokens with state variants.
 * Matches the Pnyx color token structure exactly.
 */
export type NewColorTokens = {
  // Background colors
  /** Main background color */
  readonly backgroundDefault: string
  /** Background color when pressed */
  readonly backgroundDefaultPressed: string
  /** Alternative background (cards, elevated surfaces) */
  readonly backgroundAlternative: string
  /** Alternative background on hover */
  readonly backgroundAlternativeHover: string
  /** Alternative background when pressed */
  readonly backgroundAlternativePressed: string
  /** Inverse alternative background */
  readonly backgroundAlternativeInverse: string
  /** Inverse alternative background when pressed */
  readonly backgroundAlternativeInversePressed: string
  /** General hover state background */
  readonly backgroundHover: string
  /** General pressed state background */
  readonly backgroundPressed: string
  /** Form field background */
  readonly backgroundFormField: string
  /** Alternative form field background */
  readonly backgroundAlternativeFormField: string
  /** Muted alternative background */
  readonly backgroundAlternativeMuted: string
  /** Semi-transparent layer background */
  readonly backgroundLayer1: string
  /** Dashboard menu background */
  readonly backgroundNavigation: string

  // Text colors
  /** Primary text color */
  readonly textDefault: string
  /** Secondary/alternative text color */
  readonly textAlternative: string
  /** Muted/disabled text color */
  readonly textMuted: string

  // Logo colors
  /** Primary logo color */
  readonly logoPrimary: string

  // Icon colors
  /** Default icon color */
  readonly iconDefault: string
  /** Static color */
  readonly iconStatic: string
  /** Alternative icon color */
  readonly iconAlternative: string
  /** Muted icon color */
  readonly iconMuted: string

  // Border colors
  /** Weak/subtle border */
  readonly borderDefaultWeak: string
  /** Strong/prominent border */
  readonly borderDefaultStrong: string
  /** Focus state border */
  readonly borderFocus: string
  /** Semi-transparent border for list dividers and separators (--color-border-subtle) */
  readonly borderSubtle: string
  /** Semi-transparent border for interactive elements — chips, inputs on elevated surfaces (--color-border-default) */
  readonly borderInteractive: string

  // Overlay colors
  /** Default overlay (modals, drawers) */
  readonly overlayDefault: string

  // Primary colors
  /** Primary button/action color */
  readonly primaryDefault: string
  /** Primary color on hover */
  readonly primaryHover: string
  /** Primary color when pressed */
  readonly primaryPressed: string
  /** Inverse primary (for dark backgrounds) */
  readonly primaryInverse: string
  /** Alternative primary */
  readonly primaryAlternative: string
  /** Inverse alternative primary */
  readonly primaryAlternativeInverse: string
  /** Alternative primary when pressed */
  readonly primaryAlternativePressed: string
  /** Muted primary */
  readonly primaryMuted: string
  /**
   * Alpha-based primary border. Mirrors the successBorder / errorBorder pattern —
   * rgba 28% of the primary ramp — used for outline-primary affordances such as
   * the earn pill.
   */
  readonly primaryBorder: string
  /** Primary 300 — lighter brand-blue shade (gradient endpoints, accents) */
  readonly primary300: string
  /** Primary 400 — lighter brand-blue shade (gradient endpoints, accents) */
  readonly primary400: string
  /** Accent-tinted muted fill — subtle accent overlay for chips / explainer notes. */
  readonly accentMuted: string
  /** Accent-tinted outline — matches `accentMuted` at higher alpha. */
  readonly accentBorder: string
  /** Accent "light" variant — primary ramp shade tuned for foreground contrast (lighter blue on dark, darker blue on light). */
  readonly accentLight: string

  // Secondary colors
  /** Secondary action color */
  readonly secondaryDefault: string
  /** Inverse secondary */
  readonly secondaryInverse: string

  // Error colors
  /** Error state color */
  readonly errorDefault: string
  /** Error color when pressed */
  readonly errorPressed: string
  /** Muted error */
  readonly errorMuted: string
  /** Inverse error */
  readonly errorInverse: string
  /** Alternative error */
  readonly errorAlternative: string
  /** Alternative error when pressed */
  readonly errorAlternativePressed: string
  /**
   * Alpha-based critical-color border. Use for the outline-critical button
   * pattern (card surface + 1 px hairline of subdued red) and for any
   * destructive-affordance border that shouldn't read as a solid red rule.
   * Subdued red hairline (rgba 28–30 % red).
   */
  readonly errorBorder: string

  // Success colors
  /** Success state color */
  readonly successDefault: string
  /** Muted success surface — alpha-overlay tint of the success ramp. */
  readonly successMuted: string
  /**
   * Alpha-based success border (rgba 28 % of the success ramp) — softer than
   * `successDefault`, used for
   * outline-success affordances (e.g. the portfolio 24h delta pill).
   */
  readonly successBorder: string
  /** Alternative success */
  readonly successAlternative: string

  // Warning colors
  /** Warning state color */
  readonly warningDefault: string
  /** Muted warning */
  readonly warningMuted: string

  // Info colors
  /** Info state color */
  readonly infoDefault: string

  // Button overlay colors (for icon buttons on images/gradients)
  /** Dark overlay button background */
  readonly btnIconOverlayDark: string
  /** Dark overlay button icon */
  readonly btnIconOverlayDarkIcon: string
  /** Dark overlay button pressed */
  readonly btnIconOverlayDarkPressed: string
  /** Light overlay button background */
  readonly btnIconOverlayLight: string
  /** Light overlay button icon */
  readonly btnIconOverlayLightIcon: string
  /** Light overlay button pressed */
  readonly btnIconOverlayLightPressed: string

  // Gradient colors
  /** Gradient start color (for diagonal/linear gradients) */
  readonly gradientStart: string
  /** Gradient end color (for diagonal/linear gradients) */
  readonly gradientEnd: string

  /** Primary button gradient start (lighter, ~primary/400) */
  readonly btnPrimaryGradientStart: string
  /** Primary button gradient end (darker, ~primary/600) */
  readonly btnPrimaryGradientEnd: string
  /** Primary button gradient start on hover (~primary/500) */
  readonly btnPrimaryGradientStartHover: string
  /** Primary button gradient end on hover (~primary/700) */
  readonly btnPrimaryGradientEndHover: string
  /** Primary button gradient start when pressed (~primary/600) */
  readonly btnPrimaryGradientStartPressed: string
  /** Primary button gradient end when pressed (~primary/800) */
  readonly btnPrimaryGradientEndPressed: string

  /** Transparent color */
  readonly transparent: string
}

/**
 * Combined color tokens with both new semantic names and legacy names.
 * During the migration period, both are available for backward compatibility.
 */
export type ColorTokens = NewColorTokens & LegacyColorTokens

/**
 * Legacy spacing tokens (numeric keys).
 * @deprecated Use new spacing tokens (spacing4, spacing8, etc.)
 */
export type LegacySpacing = {
  /** @deprecated Use 0 directly */
  readonly 0: number
  /** @deprecated Use spacing.spacing4 */
  readonly 1: number
  /** @deprecated Use spacing.spacing8 */
  readonly 2: number
  /** @deprecated Use spacing.spacing12 */
  readonly 3: number
  /** @deprecated Use spacing.spacing16 */
  readonly 4: number
  /** @deprecated Use spacing.spacing20 */
  readonly 5: number
  /** @deprecated Use spacing.spacing24 */
  readonly 6: number
  /** @deprecated Use spacing.spacing32 */
  readonly 8: number
  /** @deprecated Use spacing.spacing40 */
  readonly 10: number
  /** @deprecated Use spacing.spacing48 */
  readonly 12: number
  /** @deprecated Use spacing.spacing80 */
  readonly 16: number
  /** @deprecated Use spacing.spacing80 */
  readonly 20: number
  /** @deprecated Use spacing.spacing104 */
  readonly 24: number
  /** @deprecated Use spacing.spacing160 */
  readonly 32: number
}

/**
 * Legacy border radius tokens.
 * @deprecated Use new tokens (rounded4, rounded8, etc.)
 */
export type LegacyRadius = {
  readonly none: number
  /** @deprecated Use borderRadius.rounded4 */
  readonly sm: number
  /** @deprecated Use borderRadius.rounded8 */
  readonly md: number
  /** @deprecated Use borderRadius.rounded12 */
  readonly lg: number
  /** @deprecated Use borderRadius.rounded16 */
  readonly xl: number
  /** @deprecated Use borderRadius.roundedCircle */
  readonly full: number
}

/**
 * Legacy typography structure.
 * @deprecated Use textVariants for complete typography styles
 */
export type LegacyTypography = {
  readonly fontFamily: string
  readonly monoFontFamily: string
  readonly fontSize: {
    readonly xs: number
    readonly sm: number
    readonly md: number
    readonly lg: number
    readonly xl: number
    readonly '2xl': number
    readonly '3xl': number
    readonly '4xl': number
  }
  readonly fontWeight: {
    readonly light: '300'
    readonly regular: '400'
    readonly medium: '500'
    readonly semibold: '600'
    readonly bold: '700'
  }
  readonly lineHeight: {
    readonly tight: number
    readonly normal: number
    readonly relaxed: number
  }
}

/**
 * Base theme type - what presets define (without legacy properties).
 * This is used internally by presets.
 */
export type BaseTheme = {
  /** Theme identifier */
  readonly name: string
  /** New semantic color tokens */
  readonly colors: NewColorTokens
  /** Spacing tokens (spacing2, spacing4, etc.) */
  readonly spacing: Spacing
  /** Border radius tokens (rounded4, rounded8, etc.) */
  readonly borderRadius: BorderRadius
  /** Chamfer cut-length tokens (cut4, cut8, etc.) */
  readonly chamfer: Chamfer
  /** Border width tokens */
  readonly borderWidth: BorderWidth
  /** Icon size tokens */
  readonly iconSizes: IconSizes
  /** Button height tokens */
  readonly buttonSizes: ButtonSizes
  /** Row height tokens */
  readonly rowSizes: RowSizes
  /** Input height tokens */
  readonly inputSizes: InputSizes
  /** Text variant definitions */
  readonly textVariants: TextVariants
  /** Font weight values */
  readonly fontWeights: FontWeights
  /** Font family mappings */
  readonly fontFamily: {
    readonly light: string
    readonly regular: string
    readonly medium: string
    readonly semiBold: string
    readonly bold: string
    readonly extraBold: string
  }
  /** Font size values */
  readonly fontSizes: FontSizes
  /** Line height values */
  readonly lineHeights: LineHeights
  /** Letter spacing tokens */
  readonly letterSpacing: LetterSpacing
  /** Grid column count tokens */
  readonly gridColumns: GridColumns
  /** Animation configurations */
  readonly animations: Animations
  /** Opacity levels */
  readonly opacity: Opacity
  /** Color alpha hex values */
  readonly colorAlpha: ColorAlpha
  /** Platform-specific sizes */
  readonly otherSizes: OtherSizes
  /** Per-theme button border radius */
  readonly buttonBorderRadius: number
}

/**
 * Complete theme type with backward compatibility.
 * This is what the app uses - includes both new and legacy tokens.
 */
export type Theme = BaseTheme & {
  /** Color tokens (includes legacy names for compatibility) */
  readonly colors: ColorTokens
  /** Spacing tokens - new names and legacy numeric keys */
  readonly spacing: Spacing & LegacySpacing
  /** @deprecated Legacy typography structure - use textVariants instead */
  readonly typography: LegacyTypography
  /** @deprecated Legacy border radius - use borderRadius instead */
  readonly radius: LegacyRadius
  /** @deprecated Legacy gap function - use spacing tokens directly */
  readonly gap: (multiplier: number) => number
}

/**
 * Deprecated token mapping for backward compatibility.
 *
 * Maps old token names to new token names.
 * Use this during migration to find the correct new token.
 *
 * @example
 * ```ts
 * // Old: theme.colors.primary
 * // New: theme.colors.primaryDefault
 * ```
 */
export const deprecatedColorMap = {
  primary: 'primaryDefault',
  primaryForeground: 'primaryInverse',
  secondary: 'secondaryDefault',
  accent: 'secondaryDefault',
  background: 'backgroundDefault',
  surface: 'backgroundAlternative',
  surfaceHover: 'backgroundAlternativeHover',
  text: 'textDefault',
  textSecondary: 'textAlternative',
  error: 'errorDefault',
  success: 'successDefault',
  warning: 'warningDefault',
  info: 'infoDefault',
  border: 'borderDefaultStrong',
  disabled: 'textMuted',
  white: 'primaryInverse', // Context-dependent
  black: 'primaryDefault', // Context-dependent
} as const

/**
 * Deprecated spacing mapping for backward compatibility.
 */
export const deprecatedSpacingMap = {
  0: 0, // No direct mapping, use 0
  1: 'spacing4',
  2: 'spacing8',
  3: 'spacing12',
  4: 'spacing16',
  5: 'spacing20',
  6: 'spacing24',
  8: 'spacing32',
  10: 'spacing40',
  12: 'spacing48',
  16: 'spacing80', // Approximate (64 → 80)
  20: 'spacing80',
  24: 'spacing104', // Approximate (96 → 104)
  32: 'spacing160', // Approximate (128 → 160)
} as const

/**
 * Deprecated radius mapping for backward compatibility.
 */
export const deprecatedRadiusMap = {
  none: 'none',
  sm: 'rounded4',
  md: 'rounded8',
  lg: 'rounded12',
  xl: 'rounded16',
  full: 'roundedCircle',
} as const
