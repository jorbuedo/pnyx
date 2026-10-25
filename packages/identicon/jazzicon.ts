/**
 * Jazzicon identicon generator.
 *
 * Generates deterministic SVG identicons with overlapping rotated rectangles
 * and hue-shifted colors. Same style as MetaMask/Ethereum account icons.
 *
 * Uses Mersenne Twister PRNG for deterministic generation from hex seed.
 *
 * No external dependencies (inline Mersenne Twister, inline hue spin).
 *
 * @module
 */

// ============================================================================
// Color manipulation (hue spin)
// ============================================================================

const hexToRgb = (hex: string): {r: number; g: number; b: number} => {
  const clean = hex.startsWith('#') ? hex.slice(1) : hex
  const num = Number.parseInt(clean, 16)
  return {
    r: (num >> 16) & 0xff,
    g: (num >> 8) & 0xff,
    b: num & 0xff,
  }
}

const rgbToHsl = (r: number, g: number, b: number): {h: number; s: number; l: number} => {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2

  if (max === min) return {h: 0, s: 0, l}

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

const hue2rgb = (p: number, q: number, t: number): number => {
  const tt = t < 0 ? t + 1 : t > 1 ? t - 1 : t
  if (tt < 1 / 6) return p + (q - p) * 6 * tt
  if (tt < 1 / 2) return q
  if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6
  return p
}

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

/** Shift the hue of a hex color by the given number of degrees. */
const spinHue = (hex: string, degrees: number): string => {
  const {r, g, b} = hexToRgb(hex)
  const {h, s, l} = rgbToHsl(r, g, b)
  const newH = ((h * 360 + degrees) % 360) / 360
  return hslToHex(newH < 0 ? newH + 1 : newH, s, l)
}

// ============================================================================
// Mersenne Twister (MT19937)
// ============================================================================

const N = 624
const M = 397
const MATRIX_A = 0x9908b0df
const UPPER_MASK = 0x80000000
const LOWER_MASK = 0x7fffffff

function createMT(seed: number) {
  const mt = new Int32Array(N)
  let mti = N + 1

  /** Unchecked access — all call sites use indices guaranteed in [0, N). */
  const at = (i: number): number => mt[i] as number

  const initSeed = (s: number) => {
    mt[0] = s >>> 0
    for (mti = 1; mti < N; mti++) {
      const prev = at(mti - 1)
      mt[mti] = (((prev ^ (prev >>> 30)) >>> 0) * 1812433253 + mti) >>> 0
    }
  }

  const mag = (y: number): number => (y & 1 ? MATRIX_A : 0)

  const generateNumbers = () => {
    let kk: number
    let y: number

    for (kk = 0; kk < N - M; kk++) {
      y = (at(kk) & UPPER_MASK) | (at(kk + 1) & LOWER_MASK)
      mt[kk] = at(kk + M) ^ (y >>> 1) ^ mag(y)
    }
    for (; kk < N - 1; kk++) {
      y = (at(kk) & UPPER_MASK) | (at(kk + 1) & LOWER_MASK)
      mt[kk] = at(kk + (M - N)) ^ (y >>> 1) ^ mag(y)
    }
    y = (at(N - 1) & UPPER_MASK) | (at(0) & LOWER_MASK)
    mt[N - 1] = at(M - 1) ^ (y >>> 1) ^ mag(y)
    mti = 0
  }

  /** Returns a random number in [0, 1). */
  const random = (): number => {
    if (mti >= N) generateNumbers()

    let y = at(mti++)
    y ^= y >>> 11
    y ^= (y << 7) & 0x9d2c5680
    y ^= (y << 15) & 0xefc60000
    y ^= y >>> 18

    return (y >>> 0) * (1.0 / 4294967296.0)
  }

  initSeed(seed)
  return {random, initSeed}
}

// ============================================================================
// Color scheme
// ============================================================================

const jazziconColorScheme = [
  '#01888C',
  '#FC7500',
  '#034F5D',
  '#F73F01',
  '#FC1960',
  '#C7144C',
  '#F3C100',
  '#1598F2',
  '#2465E1',
  '#F19E02',
] as const

// ============================================================================
// Jazzicon
// ============================================================================

export const initialShapeCount = 3
export const initialWobble = 30
export const initialSize = 100

type JazziconOptions = {
  seed: string
  shapeCount?: number
  wobble?: number
  colors?: readonly string[]
  size?: number
}

type RenderOptions = {
  size?: number
  /** Clip the identicon to a circle. Default: false (square). */
  clip?: 'circle'
}

type JazziconInstance = {
  asSvg(options?: RenderOptions): string
  asBase64(options?: RenderOptions): string
}

/**
 * Creates a Jazzicon instance for generating identicons from a seed.
 *
 * @param options - The options for creating the Jazzicon instance
 * @param options.seed - The seed used for generating the identicon (must be hex)
 * @param options.shapeCount - The number of shapes to generate (default: 3)
 * @param options.wobble - The wobble factor for color shifting (default: 30)
 * @param options.colors - The base color scheme (default: built-in 10-color palette)
 * @returns An object with methods to generate identicons as SVG or base64
 */
export function Jazzicon({
  seed,
  shapeCount = initialShapeCount,
  wobble = initialWobble,
  colors = jazziconColorScheme,
}: JazziconOptions): JazziconInstance {
  if (shapeCount + 1 > colors.length) throw new Error('Insufficient colors, shape count too high.')
  if (!seed.match(/^[0-9a-fA-F]+$/)) throw new Error('Seed must be a valid hexadecimal string.')
  if (seed.length < 10) throw new Error('Seed must be at least 10 characters long.')

  const generator = createMT(0)

  const nextColor = (shiftedColors: string[]): string => {
    const index = Math.floor(generator.random() * shiftedColors.length)
    const [color] = shiftedColors.splice(index, 1)
    return color ?? shiftedColors[0] ?? '#000000'
  }

  const nextTransform = (index: number): string => {
    const angle = 2 * Math.PI * generator.random()
    const velocity = (100 * (index + generator.random())) / shapeCount
    const x = Math.cos(angle) * velocity
    const y = Math.sin(angle) * velocity
    const rotation = generator.random() * 360 + generator.random() * 180
    return `translate(${x.toFixed(3)} ${y.toFixed(3)}) rotate(${rotation.toFixed(1)} 50 50)`
  }

  const generateSvg = (size: number, clip?: 'circle'): string => {
    const seedSlice = Number.parseInt(seed.slice(2, 10), 16)
    generator.initSeed(seedSlice)
    const position = generator.random()
    const hueShift = 30 * position - wobble / 2
    const shiftedColors = [...colors].map((hex) => spinHue(hex, hueShift))

    let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" x="0" y="0" viewBox="0 0 100 100">`

    if (clip === 'circle') {
      // Use seed-derived ID to avoid clipPath collisions when multiple jazzicons are on the same page
      const clipId = `jazzicon-clip-${seed.slice(0, 8)}`
      svg += `<defs><clipPath id="${clipId}"><circle cx="50" cy="50" r="50" /></clipPath></defs>`
      svg += `<g clip-path="url(#${clipId})">`
    }

    svg += `<rect x="0" y="0" width="100%" height="100%" fill="${nextColor(shiftedColors)}" />`

    for (let i = 0; i < shapeCount; i++) {
      svg += `<rect x="0" y="0" width="100%" height="100%" transform="${nextTransform(i)}" fill="${nextColor(shiftedColors)}" />`
    }

    if (clip === 'circle') svg += '</g>'
    svg += '</svg>'
    return svg
  }

  const asSvg = ({size, clip}: RenderOptions = {}): string => {
    return generateSvg(size ?? initialSize, clip)
  }

  const asBase64 = ({size, clip}: RenderOptions = {}): string => {
    const svg = generateSvg(size ?? initialSize, clip)
    const base64String = btoa(svg)
    return `data:image/svg+xml;base64,${base64String}`
  }

  return {asSvg, asBase64}
}
