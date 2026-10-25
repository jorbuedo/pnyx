/**
 * sRGB ↔ OkLCh, so a palette can be a hue and still behave like the one it was derived from.
 *
 * ⚠️ **Rotating hue in HSL would not have worked.** HSL's "lightness" is a channel average, not a
 * perceived brightness: yellow at 55% L is far brighter than violet at 55% L. Generate a dozen ramps
 * that way and white-on-accent passes AA for the dark hues and fails for the light ones — the exact
 * inconsistency the ramps are generated to avoid. OkLab is perceptually uniform, so holding `L` and
 * `C` while rotating `h` gives every palette the same lightness profile, and therefore the same
 * contrast behaviour, as the violet ramp it came from.
 *
 * ⚠️ **Chroma has to be clamped per hue.** sRGB is not a constant-chroma volume: a violet reaches a
 * higher `C` at mid lightness than a green does. Asking for violet's chroma at green's hue yields
 * out-of-gamut coordinates that clip on conversion, and clipping moves lightness — reintroducing the
 * problem this module exists to remove. {@link hexFromOklch} bisects `C` down to the gamut instead,
 * which desaturates rather than distorts.
 *
 * Matrices are Björn Ottosson's published OkLab definition.
 *
 * @module
 */

type Oklch = {readonly l: number; readonly c: number; readonly h: number}

const srgbToLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)

const linearToSrgb = (c: number): number => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055)

const linearSrgbToOklab = (r: number, g: number, b: number): {L: number; a: number; bb: number} => {
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b
  const l_ = Math.cbrt(l)
  const m_ = Math.cbrt(m)
  const s_ = Math.cbrt(s)
  return {
    L: 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    a: 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    bb: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  }
}

const oklabToLinearSrgb = (L: number, a: number, bb: number): {r: number; g: number; b: number} => {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * bb
  const m_ = L - 0.1055613458 * a - 0.0638541728 * bb
  const s_ = L - 0.0894841775 * a - 1.291485548 * bb
  const l = l_ ** 3
  const m = m_ ** 3
  const s = s_ ** 3
  return {
    r: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    b: -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  }
}

const inGamut = ({r, g, b}: {r: number; g: number; b: number}): boolean =>
  r >= -1e-4 && r <= 1 + 1e-4 && g >= -1e-4 && g <= 1 + 1e-4 && b >= -1e-4 && b <= 1 + 1e-4

/** `#rrggbb` → OkLCh. Hue is degrees, 0–360; chroma is unbounded but small in practice (< 0.4). */
export const oklchFromHex = (hex: string): Oklch => {
  const raw = hex.replace('#', '')
  const [r, g, b] = [0, 2, 4].map((i) => srgbToLinear(Number.parseInt(raw.slice(i, i + 2), 16) / 255))
  const {L, a, bb} = linearSrgbToOklab(r as number, g as number, b as number)
  const c = Math.hypot(a, bb)
  const h = ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360
  return {l: L, c, h}
}

/**
 * OkLCh → `#rrggbb`, desaturating until the colour fits sRGB.
 *
 * The bisection is on chroma alone: lightness and hue are what a derived ramp must preserve, so a
 * hue that cannot hold the reference chroma gets a slightly duller stop rather than a shifted one.
 */
export const hexFromOklch = ({l, c, h}: Oklch): string => {
  const rgbAt = (chroma: number) => {
    const rad = (h * Math.PI) / 180
    return oklabToLinearSrgb(l, chroma * Math.cos(rad), chroma * Math.sin(rad))
  }

  let usable = c
  if (!inGamut(rgbAt(c))) {
    let low = 0
    let high = c
    // 20 halvings resolves chroma far finer than an 8-bit channel can express.
    for (let i = 0; i < 20; i++) {
      const mid = (low + high) / 2
      if (inGamut(rgbAt(mid))) low = mid
      else high = mid
    }
    usable = low
  }

  const {r, g, b} = rgbAt(usable)
  const channel = (value: number): string => {
    const eight = Math.round(Math.min(1, Math.max(0, linearToSrgb(value))) * 255)
    return eight.toString(16).padStart(2, '0')
  }
  return `#${channel(r)}${channel(g)}${channel(b)}`.toUpperCase()
}
