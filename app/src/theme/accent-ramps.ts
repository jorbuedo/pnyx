/**
 * The palette axis: the eleven accent values a colour scheme replaces, and the twelve schemes.
 *
 * Everything else in a theme — neutrals, text, borders, and the semantic success/error/warning
 * ramps — is shared. That is deliberate on two counts: text-on-surface contrast cannot regress when
 * a palette changes because no palette touches it, and "error" stays the same red in every scheme,
 * because a colour that encodes meaning is not decoration.
 *
 * ⚠️ **Violet is kept verbatim, not regenerated.** It is the default and the shipped look; deriving
 * it from its own profile would round-trip to *almost* the same hexes and quietly restyle the app.
 * The other eleven are derived from violet's per-stop OkLCh lightness and chroma, rotated in hue —
 * see {@link module:./oklch} for why that is done perceptually rather than in HSL.
 *
 * ⚠️ **A ramp is not a licence to hardcode.** These values reach components as theme tokens, and
 * nothing outside `presets/` should import the ramps. The one sanctioned exception is
 * {@link swatchColorFor}: a scheme picker has to show the schemes you are *not* using, which no
 * theme token can express. It is a function rather than an export of the ramps so that stays the
 * only door.
 *
 * @module
 */

import {hexFromOklch, oklchFromHex} from './oklch'

/**
 * The surfaces and greys that carry the scheme's hue *quietly*.
 *
 * ⚠️ **Chroma is preserved, only the hue moves.** These are already tinted — the ramp's own comment
 * calls it "cool-neutral, re-toned toward the Pnyx violet hue", and the dark surfaces are frankly
 * violet navies (`#08081A`, `#161533`). Keeping their chroma and rotating the hue gives every scheme
 * the *same amount* of tint that violet has, pointed at its own colour, rather than inventing a new
 * intensity per scheme.
 *
 * ⚠️ **Lightness is preserved exactly, which is what keeps this safe.** Every text-on-surface pair
 * in the app is a contrast between two of these; equal `L` means equal contrast, so no scheme can
 * make text harder to read than violet already does. `accent-ramps.test.ts` asserts it per scheme.
 */
export type NeutralRamp = {
  readonly neutral50: string
  readonly neutral100: string
  readonly neutral200: string
  readonly neutral500: string
  readonly neutral600: string
  readonly neutral700: string
  readonly neutral800: string
  readonly neutral900: string
  readonly darkBg: string
  readonly darkSurface: string
  readonly darkSurfaceHover: string
  readonly darkTextSecondary: string
  readonly darkTextMuted: string
}

/** The accent values that vary per colour scheme. Every other token is shared across schemes. */
export type AccentRamp = {
  readonly primary50: string
  readonly primary200: string
  readonly primary300: string
  readonly primary400: string
  readonly primary500: string
  readonly primary600: string
  readonly primary700: string
  readonly primary800: string
  /** The secondary hue — a muted neighbour of primary, three degrees cooler. */
  readonly lavender500: string
  /** Dark-mode logo mark: a light shade that reads on near-black. Tracks `lavender500`. */
  readonly lilac: string
  /** Theme-invariant within a scheme: the primary-button gradient's 0% stop. */
  readonly gradientAccentStart: string
}

/**
 * Pnyx violet — the default, byte-for-byte what shipped before schemes existed.
 *
 * The profile every other scheme is derived from, so its stops are the reference for lightness and
 * chroma at each step of the ramp.
 */
const violet: AccentRamp = {
  primary50: '#F3F1FE',
  primary200: '#CAC4F8',
  primary300: '#A69CF2',
  primary400: '#8779EC',
  primary500: '#6C5CE7',
  primary600: '#5443D6',
  primary700: '#4131B9',
  primary800: '#372B91',
  lavender500: '#A29BFE',
  lilac: '#A29BFE',
  gradientAccentStart: '#6C5CE7',
}

/**
 * Violet's neutrals — the reference tint, verbatim from the palette for the same reason the accent
 * ramp is: this is the shipped look and must not move.
 */
const violetNeutrals: NeutralRamp = {
  neutral50: '#F6F5FB',
  neutral100: '#E6E6F2',
  neutral200: '#D7D8E7',
  neutral500: '#62627D',
  neutral600: '#45455F',
  neutral700: '#2C2C4A',
  neutral800: '#191A3C',
  neutral900: '#0C0B23',
  darkBg: '#08081A',
  darkSurface: '#161533',
  darkSurfaceHover: '#1D1C3B',
  darkTextSecondary: '#94A3B8',
  darkTextMuted: '#64748B',
}

/** Violet's own hue, so a derived scheme's rotation is expressed relative to the reference. */
const VIOLET_HUE = oklchFromHex(violet.primary500).h

/**
 * Violet's ramp at another hue.
 *
 * Per stop the lightness and chroma are violet's; only the hue moves, and each stop keeps its own
 * offset from `primary500`'s hue so the secondary stays the cooler neighbour it is in violet.
 */
const derive = (hue: number): AccentRamp => {
  const rotate = (reference: string): string => {
    const {l, c, h} = oklchFromHex(reference)
    return hexFromOklch({l, c, h: (hue + (h - VIOLET_HUE) + 360) % 360})
  }
  const lavender = rotate(violet.lavender500)
  return {
    primary50: rotate(violet.primary50),
    primary200: rotate(violet.primary200),
    primary300: rotate(violet.primary300),
    primary400: rotate(violet.primary400),
    primary500: rotate(violet.primary500),
    primary600: rotate(violet.primary600),
    primary700: rotate(violet.primary700),
    primary800: rotate(violet.primary800),
    lavender500: lavender,
    // Tracks the secondary by construction, exactly as violet's does.
    lilac: lavender,
    gradientAccentStart: rotate(violet.gradientAccentStart),
  }
}

/**
 * How much of violet's neutral chroma a scheme keeps, as a function of its hue.
 *
 * ⚠️ **A single factor cannot work, and trying one is what proved it.** Damped uniformly to 0.6, the
 * derived surfaces sat at chroma ~0.034 against violet's own 0.057 — *less* saturated than the
 * scheme that looked fine — and the greens, ambers and crimsons still read as coloured backgrounds
 * while violet and azure read as neutral. So the variable is not how much chroma, it is which hue:
 * dark interfaces conventionally shadow toward blue-violet, so a navy is read as neutral while a
 * dark olive or maroon at the same chroma is read as a decision.
 *
 * The falloff encodes exactly that. Hues near {@link COOL_ANCHOR} keep most of their tint; the
 * further round the wheel a scheme sits, the more it is pulled back toward grey. Violet is exempt
 * from all of it — its neutrals are the hand-designed reference.
 */
const COOL_ANCHOR = oklchFromHex('#6C5CE7').h

/** Tint kept at the anchor hue, where a cast reads as ordinary dark-UI shadow. */
const TINT_AT_COOL = 0.6

/** Tint kept opposite the anchor, where the same cast reads as a colour choice. */
const TINT_AT_WARM = 0.2

/** Violet's neutral chroma is scaled by this before being rotated to `hue`. */
const tintStrengthFor = (hue: number): number => {
  const away = (((hue - COOL_ANCHOR) % 360) + 360) % 360
  // 1 at the anchor, 0 directly opposite, cosine-smooth in between — no steps for a scheme to
  // land on the wrong side of.
  const coolness = 0.5 + 0.5 * Math.cos((away * Math.PI) / 180)
  return TINT_AT_WARM + (TINT_AT_COOL - TINT_AT_WARM) * coolness
}

/**
 * Violet's neutrals, rotated by the same delta as the accent and damped.
 *
 * Each keeps its own offset from violet's hue, so the ramp's internal relationships survive — the
 * dark surfaces stay a shade apart, and the slate text colours keep their distance from the greys.
 */
const deriveNeutrals = (hue: number): NeutralRamp => {
  const rotate = (reference: string): string => {
    const {l, c, h} = oklchFromHex(reference)
    const rotated = (hue + (h - VIOLET_HUE) + 360) % 360
    return hexFromOklch({l, c: c * tintStrengthFor(hue), h: rotated})
  }
  return {
    neutral50: rotate(violetNeutrals.neutral50),
    neutral100: rotate(violetNeutrals.neutral100),
    neutral200: rotate(violetNeutrals.neutral200),
    neutral500: rotate(violetNeutrals.neutral500),
    neutral600: rotate(violetNeutrals.neutral600),
    neutral700: rotate(violetNeutrals.neutral700),
    neutral800: rotate(violetNeutrals.neutral800),
    neutral900: rotate(violetNeutrals.neutral900),
    darkBg: rotate(violetNeutrals.darkBg),
    darkSurface: rotate(violetNeutrals.darkSurface),
    darkSurfaceHover: rotate(violetNeutrals.darkSurfaceHover),
    darkTextSecondary: rotate(violetNeutrals.darkTextSecondary),
    darkTextMuted: rotate(violetNeutrals.darkTextMuted),
  }
}

/** One colour scheme: its accent, and the neutrals tinted to match. */
export type Scheme = {readonly accent: AccentRamp; readonly neutral: NeutralRamp}

/**
 * The twelve schemes, evenly spaced around the wheel from violet.
 *
 * Even spacing rather than hand-picked hues: it makes the set complete and non-arbitrary, and every
 * entry inherits violet's contrast behaviour. Names describe where the hue actually lands — pinned
 * by `accent-ramps.test.ts`, because rotation in OkLCh runs violet → purple → magenta → red →
 * orange → … , which is the opposite of the direction a first guess assumes.
 */
const at = (offset: number): Scheme =>
  offset === 0
    ? {accent: violet, neutral: violetNeutrals}
    : {accent: derive(VIOLET_HUE + offset), neutral: deriveNeutrals(VIOLET_HUE + offset)}

export const schemes = {
  violet: at(0),
  purple: at(30),
  magenta: at(60),
  crimson: at(90),
  orange: at(120),
  amber: at(150),
  olive: at(180),
  green: at(210),
  emerald: at(240),
  teal: at(270),
  cyan: at(300),
  azure: at(330),
} as const satisfies Record<string, Scheme>

/** The accent half of each scheme, for callers that only need a colour. */
export const accentRamps = Object.fromEntries(
  Object.entries(schemes).map(([name, scheme]) => [name, scheme.accent]),
) as Record<keyof typeof schemes, AccentRamp>

/** Which colour scheme the accent comes from. `violet` is the default. */
export type AccentName = keyof typeof schemes

export const accentNames = Object.keys(schemes) as readonly AccentName[]

/**
 * The colour the logo mark takes for a scheme in a mode — what one picker swatch shows.
 *
 * Mirrors `logoPrimary` exactly (`primary600` in light, `lilac` in dark), so a swatch is a preview
 * of the mark rather than an approximation of it.
 */
export const swatchColorFor = (accent: AccentName, dark: boolean): string =>
  dark ? accentRamps[accent].lilac : accentRamps[accent].primary600
