/**
 * Blockies identicon generator.
 *
 * Generates deterministic SVG identicons from hex seed strings.
 * Uses XORshift PRNG and a curated color scheme palette.
 *
 * Derived from the open-source blockies algorithm (as packaged in Yoroi's
 * `@yoroi/identicon`).
 *
 * @module
 */

/* eslint-disable no-bitwise */
import {colorSaturation} from './color-saturation.js'
import {colorScheme} from './color-scheme.js'

type BlockiesOptions = {size?: number; scale?: number; saturationFactor?: number}

type BlockiesInstance = {
  asSvg(options?: BlockiesOptions): string
  asBase64(options?: BlockiesOptions): string
}

/**
 * Creates a Blockies instance for generating identicons from a seed.
 *
 * @param options - The options for creating the Blockies instance
 * @param options.seed - The seed used for generating the identicon (must be hex)
 * @returns An object with methods to generate identicons
 */
export function Blockies({seed}: {seed: string}): BlockiesInstance {
  const randseed: [number, number, number, number] = [0, 0, 0, 0]

  const seedrand = (seedValue: string) => {
    randseed[0] = 0
    randseed[1] = 0
    randseed[2] = 0
    randseed[3] = 0
    for (let i = 0; i < seedValue.length; i++) {
      const idx = (i % 4) as 0 | 1 | 2 | 3
      randseed[idx] = (randseed[idx] << 5) - randseed[idx] + seedValue.charCodeAt(i)
    }
  }

  const rand = (): number => {
    const t = randseed[0] ^ (randseed[0] << 11)
    randseed[0] = randseed[1]
    randseed[1] = randseed[2]
    randseed[2] = randseed[3]
    randseed[3] = randseed[3] ^ (randseed[3] >> 19) ^ t ^ (t >> 8)

    return (randseed[3] >>> 0) / ((1 << 31) >>> 0)
  }

  const createImageData = (size: number): number[] => {
    const dataWidth = Math.ceil(size / 2)
    const mirrorWidth = size - dataWidth
    const data: number[] = []

    for (let y = 0; y < size; y++) {
      const row = Array.from({length: dataWidth}, () => Math.floor(rand() * 2.3))
      const mirrorRow = [...row.slice(0, mirrorWidth)].reverse()
      data.push(...row, ...mirrorRow)
    }
    return data
  }

  // Initialize the random seed
  seedrand(seed)

  const asSvg = ({size = 8, scale = 8, saturationFactor = 0}: BlockiesOptions = {}): string => {
    const seedBytes = hexToBytes(seed)
    const firstByte = seedBytes[0] ?? 0
    const colorIdx = seedBytes.length < 1 ? 0 : firstByte % colorScheme.length

    const colors = colorScheme[colorIdx]

    const backgroundColor = colors ? colorSaturation(colors.primary, saturationFactor) : '#E1F2FF'
    const mainColor = colors ? colorSaturation(colors.secondary, saturationFactor) : '#17D1AA'
    const spotColor = colors ? colorSaturation(colors.spots, saturationFactor) : '#A80B32'

    const imageData = createImageData(size)
    const width = size * scale
    const height = size * scale

    let svgContent = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">`

    for (let i = 0; i < imageData.length; i++) {
      const item = imageData[i]
      const fill = item === 0 ? backgroundColor : item === 1 ? mainColor : spotColor
      const row = Math.floor(i / size)
      const col = i % size
      svgContent += `<rect x="${col * scale}" y="${row * scale}" width="${scale}" height="${scale}" fill="${fill}" />`
    }

    svgContent += '</svg>'
    return svgContent
  }

  const asBase64 = (options?: BlockiesOptions): string => {
    const svgContent = asSvg(options)
    const base64String = btoa(svgContent)
    return `data:image/svg+xml;base64,${base64String}`
  }

  return {asSvg, asBase64}
}

/**
 * Decode a hex string to bytes.
 */
function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  if (clean.length === 0) return new Uint8Array(0)
  const bytes = new Uint8Array(clean.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}
