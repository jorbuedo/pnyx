/**
 * Color palette definitions for Pnyx brand.
 *
 * Raw color values used to build semantic theme tokens.
 *
 * Naming follows the design spec (`Neutral/0..900`, `Primary/50..800`). Only
 * keys actually consumed by the preset are defined.
 *
 * @module
 */

/**
 * Parses a hex color string into RGB components.
 */
export const parseHexToRgb = (hex: string): {r: number; g: number; b: number} => {
  hex = hex.replace(/^#/, '')
  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  return {r, g, b}
}

/**
 * Adds opacity to a hex color, returning an rgba string.
 */
export const hexToRgba = (hex: string, opacity: number): string => {
  const rgb = parseHexToRgb(hex)
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${opacity})`
}

// Brand accent — violet #6C5CE7. The ramp below is built in HSL around hue 247°.
const _PNYX_VIOLET = '#6C5CE7' // brand-violet — Primary/500, hsl(247 74% 63%)
const _PNYX_LAVENDER = '#A29BFE' // brand-lavender — muted violet neighbor (secondary hue)
// Theme-invariant brand-gradient start (Button v2 primary gradient, 0% stop).
// Kept as its own key so the gradient endpoint stays a single source of
// truth. Both CTA gradient stops hold ≥4.5:1 with white (AA normal text):
// #6C5CE7 = 4.86:1, #5443D6 = 6.66:1.
const _PNYX_GRADIENT_VIOLET = _PNYX_VIOLET
const _PNYX_BLACK = '#000000'
const _PNYX_WHITE = '#FFFFFF'

export const pnyxPalette = {
  // Base
  black: _PNYX_BLACK,
  black_35: hexToRgba(_PNYX_BLACK, 0.35),
  black_50: hexToRgba(_PNYX_BLACK, 0.5),
  black_60: hexToRgba(_PNYX_BLACK, 0.6),
  white: _PNYX_WHITE,
  white_25: hexToRgba(_PNYX_WHITE, 0.25),
  white_35: hexToRgba(_PNYX_WHITE, 0.35),
  white_50: hexToRgba(_PNYX_WHITE, 0.5),
  white_60: hexToRgba(_PNYX_WHITE, 0.6),

  // Primary ramp — brand violet, hue 247°, saturation easing toward the ends.
  primary50: '#F3F1FE',
  primary100: '#E6E3FC',
  primary200: '#CAC4F8',
  primary300: '#A69CF2',
  primary400: '#8779EC',
  primary500: _PNYX_VIOLET, // #6C5CE7
  primary600: '#5443D6',
  primary700: '#4131B9',
  primary800: '#372B91',

  // Secondary ramp — brand lavender (muted violet neighbor, hue 244°).
  lavender500: _PNYX_LAVENDER,
  lavender500_25: hexToRgba(_PNYX_LAVENDER, 0.25),
  secondary300: '#C1BDFF',
  secondary400: '#B4AEFE',
  // secondary500 === lavender500 === _PNYX_LAVENDER
  secondary600: '#8780EF',
  secondary700: '#6861D1',

  // Lilac — dark-mode logo primary (light violet that reads on near-black).
  lilac: _PNYX_LAVENDER,
  // Theme-invariant brand gradient stop (Button v2 primary gradient start, 0%).
  gradientAccentStart: _PNYX_GRADIENT_VIOLET,

  // Neutral ramp — cool-neutral, re-toned toward the Pnyx violet hue.
  neutral0: '#FFFFFF',
  neutral25: '#FCFCFE',
  neutral50: '#F6F5FB',
  neutral75: '#EEEDF7',
  neutral100: '#E6E6F2',
  neutral200: '#D7D8E7',
  neutral300: '#B9BAD0',
  neutral400: '#8B8CA4',
  neutral500: '#62627D',
  neutral600: '#45455F',
  neutral700: '#2C2C4A',
  neutral800: '#191A3C',
  neutral900: '#0C0B23',
  neutral950: '#08081A',

  // Light-mode overlays — Neutral/900 alphas.
  lightOverlayDefault: hexToRgba('#0C0B23', 0.56),
  lightOverlayIcon: hexToRgba('#0C0B23', 0.06),
  lightOverlayIconAlt: hexToRgba('#0C0B23', 0.04),

  // Dark-mode navy-tinted surfaces (semantic tokens).
  darkBg: '#08081A', // --color-bg-base
  darkSecondary: '#101024', // --color-bg-secondary / sheets
  darkSurface: '#161533', // --color-bg-card
  darkSurfaceHover: '#1D1C3B', // --color-bg-elevated
  darkBgSurface: '#1D1C3B', // elevated/pressed legacy alias
  darkBorder: hexToRgba(_PNYX_WHITE, 0.14), // --color-border-default
  darkBorderSubtle: hexToRgba(_PNYX_WHITE, 0.08), // --color-border-subtle
  darkText: _PNYX_WHITE, // --text-primary
  darkTextSecondary: '#94A3B8',
  darkTextMuted: '#64748B',

  // Dark-mode semantic signal colors (status tokens).
  positiveGreen: '#22C55E',
  positiveGreen_14: hexToRgba('#22C55E', 0.14),
  negativeRed: '#EF4444',
  // Tailwind red-600 — strong solid red for the always-on mock-mode banner.
  red600: '#DC2626',
  negativeRedHover: '#D92D20',
  negativeRedPressed: '#B91C1C',
  negativeRed_10: hexToRgba('#EF4444', 0.1),
  negativeRed_12: hexToRgba('#EF4444', 0.12),
  negativeRed_35: hexToRgba('#EF4444', 0.35),
  warningYellow: '#F59E0B',
  warningYellow_12: hexToRgba('#F59E0B', 0.12),

  // Feedback ramps (light-mode). Hex values are industry-standard (Untitled UI);
  // Brand tuning pending. Only steps consumed by the preset are defined.
  feedbackSuccess50: '#ECFDF5',
  // Dark-mode status green. Replaces the prior
  // Untitled UI #12B76A so both modes track the success ramp.
  feedbackSuccess500: '#22C55E',
  feedbackSuccess600: '#039855',
  // Light-mode status green, AA-rated on white.
  feedbackSuccess700: '#047857',
  feedbackAmber50: '#FFFAEB',
  feedbackAmber600: '#DC6803',
  feedbackAmber800: '#92400E',
  feedbackCritical50: '#FEF3F2',
  feedbackCritical100: '#FEE4E2',
  feedbackCritical200: '#FECDCA',
  feedbackCritical600: '#D92D20',
  feedbackCritical700: '#B91C1C',
  feedbackCritical800: '#912018',
  feedbackInfo600: '#1570EF',

  // Token-letter fallback avatar colors
  tokenFallbackGold: '#F4CD8D',
  tokenFallbackGoldDark: '#C29E63',
  tokenFallbackInk: '#001208',
  tokenFallbackInkDark: '#FEF4E2',

  // Account / avatar accent colors — violet-family neighbors + brand yellow.
  accountBlue: '#9FADF4', // periwinkle
  accountCyan: '#BCB7FA', // light lavender
  accountYellow: '#F7E56A',

  // Marketing-promo emerald ramp.
  // Tailwind emerald scale; these are component-identity colors for the dark
  // emerald hero promo and are not part of the brand primary/success ramp.
  emerald300_70: hexToRgba('#6EE7B7', 0.7),
  emerald300_90: hexToRgba('#6EE7B7', 0.9),
  emerald500: '#10B981',
  emerald500_30: hexToRgba('#10B981', 0.3),
  emerald800: '#065F46',
  emerald900: '#064E3B',
  emerald950: '#052E16',
  // Top-centred radial highlight on emerald promos.
  // Dark mode uses green-500 @ 18%; light mode uses #059669 @ 10%.
  greenGlowDark_18: hexToRgba('#22C55E', 0.18),
  greenGlowLight_10: hexToRgba('#059669', 0.1),
  // Semi-transparent white used by the promo CTA pill.
  white_15: hexToRgba(_PNYX_WHITE, 0.15),

  // Chain brand colors (fixed — do not vary between light/dark).
  // The send flow's accent dot reads from these via `getChainAccentColor`,
  // so any chain in `SUPPORTED_CHAINS` (@pnyx/transfer) needs an entry.
  cardanoBlue: '#0033AD',
  cardanoBlueLight: '#1a4fd6',
  // Ethereum brand (#627EEA) — used as the unified chain-pill surface
  // across cardano/ethereum/solana.
  chainEthereum: '#627EEA',
  chainEthereum_16: hexToRgba('#627EEA', 0.16),
  // Foreground paired with `chainEthereum_16` — Tailwind indigo-300 (`#A5B4FC`).
  chainPillForeground: '#A5B4FC',
  // Base chain brand (#0052FF). Used outside chain selection (e.g. the
  // About logo container's inset-glow outline).
  chainBase: '#0052FF',
  // Midnight chain brand (#6D28D9).
  // Doubles as the Instagram social-chip tint on the About screen.
  chainMidnight: '#6D28D9',
  chainBitcoin: '#F7931A',
  chainBinance: '#F0B90B',
  chainAvalanche: '#E84142',
  chainSolana: '#14F195',
  chainTron: '#EB0029',

  // Social-brand inks (theme-invariant brand colors).
  // Instagram signature pink.
  instagramPink: '#F472B6',
  // Tailwind slate-100 — text color on the dark
  // X / TikTok social chips. Distinct from pure white so the chip looks ink-y.
  slate100: '#F1F5F9',
  // Tailwind slate ramp — theme-invariant terminal/"tech panel" surfaces and
  // text used by always-dark debug/error/lock UI (TxFailedScreen tech panel,
  // BiometricFirstLockScreen). Rendered identically in light and dark by design.
  slate200: '#E2E8F0',
  slate300: '#CBD5E1',
  slate800: '#1E293B',
  slate900: '#0F172A',
  slate950: '#020617',

  // Earn tab — coming-soon product icon circles.
  earnIconStablecoinYieldStart: '#2775CA',
  earnIconStablecoinYieldEnd: '#26A17B',
  earnIconRwaStart: '#8B5CF6',
} as const
