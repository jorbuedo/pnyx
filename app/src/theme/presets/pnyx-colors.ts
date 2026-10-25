/**
 * The colour tokens for a scheme, in each mode — the pure half of the Pnyx preset.
 *
 * ⚠️ **Separate from `pnyx.ts` so the contrast harness can import it.** The theme objects there pull
 * `../base`, which reaches React Native through `../platform`; a test importing that fails to parse.
 * The repo's rule for exactly this is to extract the pure logic rather than test a hand-copy of it,
 * so the colour maths lives here and `pnyx.ts` re-exports what callers already used.
 *
 * @module
 */

import type {Scheme} from '../accent-ramps'
import {bestInverse} from '../contrast'
import {hexToRgba, pnyxPalette} from '../palette'
import type {NewColorTokens} from '../tokens'

/**
 * Pnyx light theme color tokens.
 */
export const lightColors = ({accent: ramp, neutral}: Scheme): NewColorTokens => ({
  // Background — light-theme spec §5.2 (tokens.light.json → themes.light.Background)
  backgroundDefault: neutral.neutral50, // app canvas #F5F7FA
  backgroundDefaultPressed: neutral.neutral200,
  backgroundAlternative: pnyxPalette.neutral0, // layer-1 card #FFFFFF
  backgroundAlternativeHover: pnyxPalette.neutral0,
  backgroundAlternativePressed: neutral.neutral200,
  backgroundAlternativeInverse: neutral.neutral900,
  backgroundAlternativeInversePressed: neutral.neutral700,
  backgroundHover: hexToRgba(ramp.primary500, 0.06), // Primary/500 @ 6%
  backgroundPressed: neutral.neutral200,
  backgroundFormField: pnyxPalette.neutral0, // inputs white on canvas
  backgroundAlternativeFormField: pnyxPalette.neutral0,
  backgroundAlternativeMuted: '#EEF1F6',
  backgroundLayer1: pnyxPalette.neutral0,
  backgroundNavigation: pnyxPalette.neutral0, // nav white

  // Text — light-theme spec §5.3
  textDefault: neutral.neutral900, // #0B1020
  textAlternative: neutral.neutral600,
  textMuted: '#5F6875',

  // Logo
  logoPrimary: ramp.primary600,

  // Icon — light-theme spec §5.4
  iconDefault: neutral.neutral700, // #2B3346
  iconStatic: pnyxPalette.neutral0,
  iconAlternative: neutral.neutral600, // #434B5C
  iconMuted: neutral.neutral500, // #61697A (decorative only)

  // Border — light-theme spec §5.5
  borderDefaultWeak: hexToRgba(neutral.neutral900, 0.06),
  borderDefaultStrong: hexToRgba(neutral.neutral900, 0.22),
  borderFocus: ramp.primary500,
  borderSubtle: hexToRgba(neutral.neutral900, 0.06), // --color-border-subtle light
  borderInteractive: hexToRgba(neutral.neutral900, 0.12), // --color-border-default light

  // Overlay — light-theme spec §5.6 (Neutral/900 alphas)
  overlayDefault: pnyxPalette.lightOverlayDefault,

  // Primary — violet ramp (CTA fill = Primary/600, hover = Primary/700)
  primaryDefault: ramp.primary600,
  primaryHover: ramp.primary700,
  primaryPressed: ramp.primary800,
  primaryInverse: bestInverse(ramp.primary600, [pnyxPalette.neutral0, neutral.neutral900]),
  primaryAlternative: ramp.primary50,
  primaryAlternativeInverse: ramp.primary600,
  primaryAlternativePressed: ramp.primary200,
  primaryMuted: ramp.primary50,
  // Outline-primary border — rgba 28% of the primary ramp, mirrors successBorder / errorBorder.
  primaryBorder: hexToRgba(ramp.primary600, 0.28),
  primary300: ramp.primary300,
  primary400: ramp.primary400,
  // Accent muted / border (light): primary600 @ 10% / 22%.
  accentMuted: hexToRgba(ramp.primary600, 0.1),
  accentBorder: hexToRgba(ramp.primary600, 0.22),
  accentLight: ramp.primary700,

  // ⚠️ Secondary. Which side is legible is a property of the hue, not a choice: white on violet's
  // own #A29BFE is well below AA while neutral-900 on it is 7.8:1 — and a lighter scheme's
  // secondary flips that. Measured per scheme so no palette can ship an unreadable label.
  secondaryDefault: ramp.lavender500,
  secondaryInverse: bestInverse(ramp.lavender500, [neutral.neutral900, pnyxPalette.neutral0]),

  // Error — Critical feedback ramp
  errorDefault: pnyxPalette.feedbackCritical600,
  errorPressed: pnyxPalette.feedbackCritical800,
  errorMuted: pnyxPalette.feedbackCritical50,
  errorInverse: pnyxPalette.neutral0,
  errorAlternative: pnyxPalette.feedbackCritical50,
  errorAlternativePressed: pnyxPalette.feedbackCritical200,
  // Outline-critical border (light): rgba(220, 38, 38, 0.28).
  errorBorder: hexToRgba(pnyxPalette.feedbackCritical600, 0.28),

  // Success (light): success-700 base + alpha
  // overlays for surface (10%) and border (28%). Light-mode status green is
  // AA-rated on white.
  successDefault: pnyxPalette.feedbackSuccess700,
  successMuted: hexToRgba(pnyxPalette.feedbackSuccess700, 0.1),
  successBorder: hexToRgba(pnyxPalette.feedbackSuccess700, 0.28),
  successAlternative: pnyxPalette.feedbackSuccess500,

  // Warning — Amber feedback ramp
  warningDefault: pnyxPalette.feedbackAmber800,
  warningMuted: hexToRgba(pnyxPalette.feedbackAmber800, 0.1),

  // Info — Info feedback ramp
  infoDefault: pnyxPalette.feedbackInfo600,

  // Button overlay colors
  btnIconOverlayDark: pnyxPalette.black_35,
  btnIconOverlayDarkIcon: pnyxPalette.white,
  btnIconOverlayDarkPressed: pnyxPalette.black_60,
  btnIconOverlayLight: pnyxPalette.white_35,
  btnIconOverlayLightIcon: pnyxPalette.black,
  btnIconOverlayLightPressed: pnyxPalette.white_60,

  // Social-chip tokens (About screen).
  // Light theme: X and TikTok flip to a white surface with a neutral-900 ink.
  // Light info-surface = primary600 @ 8%.
  // Gradient — brand: violet → lavender
  gradientStart: ramp.primary600,
  gradientEnd: ramp.lavender500,

  // Button gradient — brand gradient (violet 500 → violet 600).
  // `Start` is the 0% stop (top-left), `End` is the 100% stop (bottom-right).
  // Hover/pressed darken the end while holding the start steady. Both stops
  // keep ≥4.5:1 with white label text (see palette.ts).
  btnPrimaryGradientStart: ramp.gradientAccentStart,
  btnPrimaryGradientEnd: ramp.primary600,
  btnPrimaryGradientStartHover: ramp.gradientAccentStart,
  btnPrimaryGradientEndHover: ramp.primary700,
  btnPrimaryGradientStartPressed: ramp.gradientAccentStart,
  btnPrimaryGradientEndPressed: ramp.primary800,

  transparent: 'transparent',
})

/**
 * Pnyx dark theme color tokens.
 */
export const darkColors = ({accent: ramp, neutral}: Scheme): NewColorTokens => ({
  // Background — semantic surface tokens.
  backgroundDefault: neutral.darkBg, // --color-bg-base #080C18
  backgroundDefaultPressed: neutral.darkSurfaceHover,
  backgroundAlternative: neutral.darkSurface, // --color-bg-card #141A2E
  backgroundAlternativeHover: neutral.darkSurfaceHover, // --color-bg-elevated #1A2035
  backgroundAlternativePressed: hexToRgba(pnyxPalette.neutral0, 0.04), // --color-bg-pressed
  backgroundAlternativeInverse: pnyxPalette.neutral0,
  backgroundAlternativeInversePressed: neutral.neutral100,
  backgroundHover: hexToRgba(pnyxPalette.neutral0, 0.06),
  backgroundPressed: hexToRgba(pnyxPalette.neutral0, 0.1),
  backgroundFormField: neutral.darkSurface,
  backgroundAlternativeFormField: neutral.darkSurfaceHover,
  backgroundAlternativeMuted: neutral.darkSurfaceHover,
  backgroundLayer1: neutral.darkSurface,
  backgroundNavigation: hexToRgba(neutral.darkBg, 0.95), // --color-bg-nav

  // Text — semantic text tokens.
  textDefault: pnyxPalette.darkText, // #FFFFFF
  textAlternative: neutral.darkTextSecondary, // #94A3B8
  textMuted: neutral.darkTextMuted, // #64748B

  // Logo
  logoPrimary: ramp.lilac,

  // Icon
  iconDefault: neutral.darkTextSecondary,
  iconStatic: pnyxPalette.neutral0,
  iconAlternative: pnyxPalette.neutral0,
  iconMuted: neutral.darkTextMuted,

  // Border — semantic border tokens.
  borderDefaultWeak: pnyxPalette.darkBorderSubtle,
  borderDefaultStrong: pnyxPalette.darkBorder,
  borderFocus: ramp.primary500,
  borderSubtle: hexToRgba(pnyxPalette.neutral0, 0.08), // --color-border-subtle dark
  borderInteractive: hexToRgba(pnyxPalette.neutral0, 0.14), // --color-border-default dark

  // Overlay
  overlayDefault: hexToRgba(neutral.neutral800, 0.8),

  // Primary — dark accent uses Primary/500 (brand violet), hover lighter, pressed Primary/600.
  primaryDefault: ramp.primary500,
  primaryHover: ramp.primary400,
  primaryPressed: ramp.primary600,
  primaryInverse: bestInverse(ramp.primary500, [pnyxPalette.white, pnyxPalette.black]),
  primaryAlternative: ramp.primary800,
  primaryAlternativeInverse: ramp.primary500,
  primaryAlternativePressed: ramp.primary600,
  primaryMuted: hexToRgba(ramp.primary500, 0.14),
  // Outline-primary border — rgba 28% of the primary ramp, mirrors successBorder / errorBorder.
  primaryBorder: hexToRgba(ramp.primary500, 0.28),
  primary300: ramp.primary300,
  primary400: ramp.primary400,
  // Accent muted / border (dark): primary500 @ 14% / 28%.
  accentMuted: hexToRgba(ramp.primary500, 0.14),
  accentBorder: hexToRgba(ramp.primary500, 0.28),
  accentLight: ramp.primary400,

  // Secondary — brand-lavender #A29BFE
  secondaryDefault: ramp.lavender500,
  secondaryInverse: bestInverse(ramp.lavender500, [pnyxPalette.black, pnyxPalette.white]),

  // Error (dark)
  errorDefault: pnyxPalette.negativeRed,
  errorPressed: pnyxPalette.negativeRedPressed,
  errorMuted: pnyxPalette.negativeRed_12,
  errorInverse: pnyxPalette.white,
  errorAlternative: pnyxPalette.negativeRed_10,
  errorAlternativePressed: pnyxPalette.negativeRed_35,
  // Outline-critical border (dark): rgba(239, 68, 68, 0.30).
  errorBorder: hexToRgba(pnyxPalette.negativeRed, 0.3),

  // Success (dark): success-500 base + alpha
  // overlays for surface (12%) and border (28%). Dark-mode status green
  // reads against the dark backdrop without losing saturation.
  successDefault: pnyxPalette.feedbackSuccess500,
  successMuted: hexToRgba(pnyxPalette.feedbackSuccess500, 0.12),
  successBorder: hexToRgba(pnyxPalette.feedbackSuccess500, 0.28),
  successAlternative: pnyxPalette.feedbackSuccess500,

  // Warning (dark)
  warningDefault: pnyxPalette.warningYellow,
  warningMuted: pnyxPalette.warningYellow_12,

  // Info — status blue, kept distinct from the violet accent family so
  // informational states still read as "info" (matches the light theme).
  infoDefault: pnyxPalette.feedbackInfo600,

  // Button overlay colors
  btnIconOverlayDark: pnyxPalette.black_35,
  btnIconOverlayDarkIcon: pnyxPalette.white,
  btnIconOverlayDarkPressed: pnyxPalette.black_60,
  btnIconOverlayLight: pnyxPalette.white_35,
  btnIconOverlayLightIcon: pnyxPalette.black,
  btnIconOverlayLightPressed: pnyxPalette.white_60,

  // Social-chip tokens (About screen).
  // Dark theme: X uses --color-text-secondary as bg; TikTok uses --color-bg-coming-soon
  // (rgba dark navy); both share --color-bg-glass border and slate-100 ink.
  // Dark info-surface = primary500 @ 10%.
  // Gradient — brand: violet → lavender (135deg)
  gradientStart: ramp.primary600,
  gradientEnd: ramp.lavender500,

  // Button gradient — brand gradient (violet 500 → violet 600).
  // Theme-invariant: same hex stops in dark + light. Hover/pressed shift the
  // end stop only; every stop keeps ≥4.5:1 with white label text.
  btnPrimaryGradientStart: ramp.gradientAccentStart,
  btnPrimaryGradientEnd: ramp.primary600,
  btnPrimaryGradientStartHover: ramp.gradientAccentStart,
  btnPrimaryGradientEndHover: ramp.primary500,
  btnPrimaryGradientStartPressed: ramp.gradientAccentStart,
  btnPrimaryGradientEndPressed: ramp.primary700,

  transparent: 'transparent',
})
