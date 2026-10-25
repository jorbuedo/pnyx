/**
 * Color saturation adjustment for identicon colors.
 *
 * Pure TS implementation — no external color library dependency.
 * Converts hex → HSL, adjusts saturation, converts back.
 *
 * @module
 */

/**
 * Parse a hex color string to RGB components.
 */
const hexToRgb = (hex: string): {r: number; g: number; b: number} => {
  const clean = hex.startsWith('#') ? hex.slice(1) : hex
  const num = Number.parseInt(clean, 16)
  return {
    r: (num >> 16) & 0xff,
    g: (num >> 8) & 0xff,
    b: num & 0xff,
  }
}

/**
 * Convert RGB to HSL.
 */
const rgbToHsl = (r: number, g: number, b: number): {h: number; s: number; l: number} => {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2

  if (max === min) {
    return {h: 0, s: 0, l}
  }

  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)

  let h: number
  if (max === rn) {
    h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6
  } else if (max === gn) {
    h = ((bn - rn) / d + 2) / 6
  } else {
    h = ((rn - gn) / d + 4) / 6
  }

  return {h, s, l}
}

/**
 * Convert a single HSL channel value to RGB.
 */
const hue2rgb = (p: number, q: number, t: number): number => {
  const tt = t < 0 ? t + 1 : t > 1 ? t - 1 : t
  if (tt < 1 / 6) return p + (q - p) * 6 * tt
  if (tt < 1 / 2) return q
  if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6
  return p
}

/**
 * Convert HSL to hex color string.
 */
const hslToHex = (h: number, s: number, l: number): string => {
  let r: number
  let g: number
  let b: number

  if (s === 0) {
    r = g = b = l
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s
    const p = 2 * l - q
    r = hue2rgb(p, q, h + 1 / 3)
    g = hue2rgb(p, q, h)
    b = hue2rgb(p, q, h - 1 / 3)
  }

  const toHex = (c: number): string => {
    const hex = Math.round(c * 255).toString(16)
    return hex.length === 1 ? `0${hex}` : hex
  }

  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

/**
 * Adjust the saturation of a hex color.
 *
 * @param color - Hex color string (e.g. '#FF0000')
 * @param factor - Saturation adjustment factor (-100 to 100). Positive saturates, negative desaturates.
 * @returns Adjusted hex color string
 */
export const colorSaturation = (color: string, factor: number): string => {
  if (factor < -100 || factor > 100) {
    throw new Error('[@pnyx/identicon] Expected factor between -100 and 100 (default 0)')
  }

  if (factor === 0) return color

  const {r, g, b} = hexToRgb(color)
  const {h, s, l} = rgbToHsl(r, g, b)

  const absFactor = Math.abs(factor) / 100
  const newS = factor < 0 ? s * (1 - absFactor) : s + (1 - s) * absFactor

  return hslToHex(h, Math.max(0, Math.min(1, newS)), l)
}
