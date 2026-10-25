#!/usr/bin/env bun
/**
 * Optimize SVG assets in place with svgo.
 *
 * SVGs are bundled as raw files and rendered via expo-image (UniIcon) — svgo
 * operates at the source level so output stays valid and renders identically.
 *
 * Config is tuned for this app's rendering path:
 * - viewBox is preserved (svgo 4 keeps it by default) — UniIcon resizes every
 *   icon via size presets, so a missing viewBox would break scaling.
 * - color/stroke/fill plugins disabled — some icons rely on their baked-in
 *   fill or `currentColor` for tinting (expo-image tintColor / react-native-svg).
 *
 * Usage:
 *   bun scripts/optimize-svg.ts            # optimize in place
 *   bun scripts/optimize-svg.ts --check    # report savings, write nothing
 */
import {existsSync, readFileSync, statSync, writeFileSync} from 'node:fs'
import {join, relative} from 'node:path'
import {Glob} from 'bun'
import {type Config, optimize} from 'svgo'

const ROOT = join(import.meta.dir, '..')
const DIRS = ['assets/icons', 'assets/cards']

const config: Config = {
  multipass: true,
  plugins: [
    {
      name: 'preset-default',
      params: {
        overrides: {
          convertColors: false,
          removeUselessStrokeAndFill: false,
        },
      },
    },
    'removeDimensions',
  ],
}

const check = process.argv.includes('--check')

const kb = (n: number) => `${(n / 1024).toFixed(1)}kb`

let count = 0
let before = 0
let after = 0
const regressed: string[] = []

for (const dir of DIRS) {
  if (!existsSync(join(ROOT, dir))) {
    console.warn(`⚠ skipping missing directory: ${dir}`)
    continue
  }
  const glob = new Glob('**/*.svg')
  for (const rel of glob.scanSync(join(ROOT, dir))) {
    const path = join(ROOT, dir, rel)
    const src = readFileSync(path, 'utf8')
    const srcSize = statSync(path).size

    let result: ReturnType<typeof optimize>
    try {
      result = optimize(src, {...config, path})
    } catch (err) {
      console.error(`✗ ${relative(ROOT, path)}: ${(err as Error).message}`)
      continue
    }

    const out = result.data
    const outSize = Buffer.byteLength(out, 'utf8')

    count++
    before += srcSize
    after += outSize

    // svgo never grows a sane SVG; if it does, keep original.
    if (outSize >= srcSize) {
      after += srcSize - outSize
      if (outSize > srcSize) regressed.push(relative(ROOT, path))
      continue
    }

    if (!check) writeFileSync(path, out)
  }
}

const saved = before - after
const pct = before ? ((saved / before) * 100).toFixed(1) : '0.0'

console.log(`${check ? '[check] ' : ''}${count} svg files`)
console.log(`  before: ${kb(before)}`)
console.log(`  after:  ${kb(after)}`)
console.log(`  saved:  ${kb(saved)} (${pct}%)`)
if (regressed.length) console.log(`  skipped (would grow): ${regressed.length}`)
if (check) console.log('\nNo files written (--check). Run without --check to apply.')
