/**
 * Regenerates every raster that carries the logomark, from `assets/logo.svg`.
 *
 * These were previously hand-exported from the design source, which meant a
 * change to the mark could only be carried into them by hand. Each entry below
 * records the geometry measured off the original export, so a regeneration is
 * pixel-comparable to what it replaces:
 *
 * - `markScale` — the mark's viewBox *width* as a fraction of the canvas. The
 *   viewBox is then centred, which is what put the original ink where it was.
 * - `radius` — corner rounding as a fraction of the side, 0 for full bleed.
 * - `background` — the brand gradient, a flat colour, or nothing.
 *
 * The gradient is `primary600 → lilac` along the top-left→bottom-right diagonal,
 * verified against the original exports: a plain sRGB lerp reproduces their
 * sampled midpoints exactly.
 *
 * Run: bun run logo:rasters   (add --check to verify without writing)
 *
 * @module
 */

import {existsSync} from 'node:fs'
import {readFile, writeFile} from 'node:fs/promises'
import {dirname, join, resolve} from 'node:path'
import sharp, {type OverlayOptions} from 'sharp'

const WALLET_ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..')
const SOURCE_SVG = join(WALLET_ROOT, 'assets/logo.svg')

const GRADIENT_FROM = '#5443D6'
const GRADIENT_TO = '#A29BFE'
const SPLASH_BACKGROUND = '#0D0F0D'
const MARK_COLOR = '#FFFFFF'

/** logo.svg's viewBox. The mark is not square, so height follows from width. */
const VIEWBOX_WIDTH = 174
const VIEWBOX_HEIGHT = 175

type Target = {
  path: string
  size: number
  markScale: number
  background: 'gradient' | 'transparent' | typeof SPLASH_BACKGROUND
  /** Corner rounding as a fraction of the side. */
  radius?: number
  /** Drop the alpha channel — the original export had none. */
  opaque?: boolean
  /** Background only, no mark (the adaptive icon's background layer). */
  backgroundOnly?: boolean
}

const TARGETS: Target[] = [
  {path: 'assets/logo.png', size: 512, markScale: 300 / 512, background: 'gradient', radius: 111 / 512},
  {path: 'assets/icon.png', size: 1024, markScale: 560 / 1024, background: 'gradient', opaque: true},
  {path: 'assets/adaptive-icon.png', size: 1024, markScale: 560 / 1024, background: 'transparent'},
  {
    path: 'assets/adaptive-icon-background.png',
    size: 1024,
    markScale: 0,
    background: 'gradient',
    opaque: true,
    backgroundOnly: true,
  },
  {path: 'assets/splash-icon.png', size: 512, markScale: 320 / 512, background: 'transparent'},
  {path: 'assets/favicon.png', size: 48, markScale: 34 / 48, background: 'gradient', opaque: true},
  // Android splash, one per density. All share the xxxhdpi mark scale.
  {
    path: 'android/app/src/main/res/drawable-mdpi/splashscreen_logo.png',
    size: 288,
    markScale: 498 / 1152,
    background: SPLASH_BACKGROUND,
  },
  {
    path: 'android/app/src/main/res/drawable-hdpi/splashscreen_logo.png',
    size: 432,
    markScale: 498 / 1152,
    background: SPLASH_BACKGROUND,
  },
  {
    path: 'android/app/src/main/res/drawable-xhdpi/splashscreen_logo.png',
    size: 576,
    markScale: 498 / 1152,
    background: SPLASH_BACKGROUND,
  },
  {
    path: 'android/app/src/main/res/drawable-xxhdpi/splashscreen_logo.png',
    size: 864,
    markScale: 498 / 1152,
    background: SPLASH_BACKGROUND,
  },
  {
    path: 'android/app/src/main/res/drawable-xxxhdpi/splashscreen_logo.png',
    size: 1152,
    markScale: 498 / 1152,
    background: SPLASH_BACKGROUND,
  },
]

const backgroundSvg = ({size, background, radius = 0}: Target): string | null => {
  if (background === 'transparent') return null
  const r = radius * size
  const fill = background === 'gradient' ? 'url(#brand)' : background
  const defs =
    background === 'gradient'
      ? `<defs><linearGradient id="brand" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${GRADIENT_FROM}"/><stop offset="1" stop-color="${GRADIENT_TO}"/></linearGradient></defs>`
      : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${defs}<rect width="${size}" height="${size}" rx="${r}" ry="${r}" fill="${fill}"/></svg>`
}

/** logo.svg paints with `currentColor`, which librsvg will not resolve — bind it. */
const markSvg = async (): Promise<string> => {
  const source = await readFile(SOURCE_SVG, 'utf8')
  if (!source.includes('currentColor')) {
    throw new Error(`${SOURCE_SVG} no longer uses currentColor — update the colour binding here`)
  }
  return source.replaceAll('currentColor', MARK_COLOR)
}

const render = async (target: Target, mark: string): Promise<Buffer> => {
  const {size, markScale, opaque} = target
  const layers: OverlayOptions[] = []

  const background = backgroundSvg(target)
  if (background !== null) {
    layers.push({input: Buffer.from(background), top: 0, left: 0})
  }

  if (!target.backgroundOnly) {
    const markWidth = Math.round(markScale * size)
    const markHeight = Math.round((markWidth * VIEWBOX_HEIGHT) / VIEWBOX_WIDTH)
    const rendered = await sharp(Buffer.from(mark), {density: 384})
      .resize({width: markWidth, height: markHeight, fit: 'fill'})
      .png()
      .toBuffer()
    layers.push({
      input: rendered,
      top: Math.round((size - markHeight) / 2),
      left: Math.round((size - markWidth) / 2),
    })
  }

  const canvas = sharp({
    create: {width: size, height: size, channels: 4, background: {r: 0, g: 0, b: 0, alpha: 0}},
  }).composite(layers)

  return (opaque === true ? canvas.removeAlpha() : canvas).png({compressionLevel: 9}).toBuffer()
}

const main = async () => {
  const check = process.argv.includes('--check')
  const mark = await markSvg()
  let changed = 0

  for (const target of TARGETS) {
    const path = join(WALLET_ROOT, target.path)
    if (!existsSync(path)) {
      console.warn(`skip (missing): ${target.path}`)
      continue
    }
    const next = await render(target, mark)
    const previous = await readFile(path)
    const differs = !previous.equals(next)
    if (differs) changed += 1
    if (differs && !check) await writeFile(path, next)
    console.log(`${differs ? (check ? 'would update' : 'updated') : 'unchanged  '}  ${target.path}`)
  }

  console.log(`\n${changed} of ${TARGETS.length} ${check ? 'would change' : 'written'}`)
  if (check && changed > 0) process.exit(1)
}

await main()
