#!/usr/bin/env bun
/**
 * CI gate: keep numeric borderRadius on the token scale.
 *
 * The app has one card radius (12). Values like 16 / 18 / 22 drifted in from
 * Figma exports and HTML mockups repeatedly, so this gate rejects any numeric
 * `borderRadius` literal that is neither on the token scale nor provably a
 * round/pill shape.
 *
 * A literal passes when:
 *   - it is a token value that app code is allowed to use bare: 0, 4, 8, 12
 *     (prefer `theme.borderRadius.rounded12` — the number is accepted because
 *     it is the sanctioned scale, not because it is preferred)
 *   - it is >= 100 — unmistakably "just make this fully round" (999, 999999)
 *   - the enclosing style block declares a `width` / `height` / `size` equal to
 *     the radius or twice it: that is a circle (r = d/2) or a pill (r = h)
 *
 * Anything else is drift. Fix it by moving to 12, or — if the shape really is
 * load-bearing — put the dimension in the same style block so the intent is
 * legible to the next reader as well as to this script.
 *
 * @module
 */

import {execSync} from 'node:child_process'
import {readFileSync} from 'node:fs'

/** Radii app code may write as a bare number. 16+ is deliberately excluded. */
const SCALE = new Set([0, 4, 8, 12])

/** At or above this, the author clearly means "fully round", not a card corner. */
const FULLY_ROUND = 100

/** Dimension keys that make a radius provably a circle or a pill. */
const DIMENSION_KEYS = ['width', 'height', 'minWidth', 'minHeight', 'size']

const RADIUS_PATTERN = 'border(Top|Bottom)?(Left|Right|Start|End)?Radius: *[0-9]+'

// The playground renders deliberately odd shapes to showcase primitives, and its
// dimensions are often component props rather than style keys.
const SEARCH_ROOTS = ['src', 'app']
const EXCLUDED = [/^src\/playground\//]

type Offender = {file: string; line: number; radius: number; text: string}

/**
 * The object-literal block enclosing `line`, found by walking outward to the
 * nearest unbalanced `{`. Style blocks are shallow, so brace counting is enough —
 * no need to parse.
 */
const enclosingBlock = (lines: readonly string[], lineIndex: number): string => {
  let depth = 0
  let start = lineIndex
  for (let i = lineIndex; i >= 0; i--) {
    const line = lines[i] ?? ''
    for (let c = line.length - 1; c >= 0; c--) {
      const ch = line[c]
      if (ch === '}') depth++
      else if (ch === '{') {
        if (depth === 0) {
          start = i
          i = -1
          break
        }
        depth--
      }
    }
  }
  depth = 0
  let end = lineIndex
  for (let i = start; i < lines.length; i++) {
    const line = lines[i] ?? ''
    for (const ch of line) {
      if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) {
          end = i
          i = lines.length
          break
        }
      }
    }
  }
  return lines.slice(start, end + 1).join('\n')
}

/** True when the block declares a dimension equal to the radius (pill) or twice it (circle). */
const hasMatchingDimension = (block: string, radius: number): boolean =>
  DIMENSION_KEYS.some((key) => {
    const matches = block.matchAll(new RegExp(String.raw`\b${key}: *([0-9]+)`, 'g'))
    for (const match of matches) {
      const value = Number(match[1])
      if (value === radius || value === radius * 2) return true
    }
    return false
  })

const collectHits = (): readonly string[] => {
  try {
    const raw = execSync(`grep -rEn "${RADIUS_PATTERN}" ${SEARCH_ROOTS.join(' ')} --include='*.ts' --include='*.tsx'`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return raw.split('\n').filter(Boolean)
  } catch (err) {
    const status = (err as {status?: number}).status
    // grep exits 1 when nothing matches — no radius literals at all is a pass.
    if (status === 1) return []
    process.stderr.write(`check-border-radius-tokens: grep failed (${status})\n`)
    process.exit(2)
  }
}

const main = (): void => {
  const fileCache = new Map<string, readonly string[]>()
  const offenders: Offender[] = []

  for (const hit of collectHits()) {
    const [file, lineNo, ...rest] = hit.split(':')
    if (file === undefined || lineNo === undefined) continue
    if (EXCLUDED.some((pattern) => pattern.test(file))) continue

    const text = rest.join(':').trim()
    const radiusMatch = text.match(/Radius: *([0-9]+)/)
    if (radiusMatch?.[1] === undefined) continue
    const radius = Number(radiusMatch[1])

    if (SCALE.has(radius) || radius >= FULLY_ROUND) continue

    let lines = fileCache.get(file)
    if (lines === undefined) {
      lines = readFileSync(file, 'utf8').split('\n')
      fileCache.set(file, lines)
    }

    const block = enclosingBlock(lines, Number(lineNo) - 1)
    if (hasMatchingDimension(block, radius)) continue

    offenders.push({file, line: Number(lineNo), radius, text})
  }

  if (offenders.length === 0) {
    process.stdout.write('check-border-radius-tokens: clean\n')
    return
  }

  process.stderr.write('check-border-radius-tokens: off-scale borderRadius values found:\n')
  for (const {file, line, radius, text} of offenders) {
    process.stderr.write(`  ${file}:${line}: ${text}  (radius ${radius})\n`)
  }
  process.stderr.write(
    [
      '',
      `Allowed bare: ${[...SCALE].join(', ')} — or >= ${FULLY_ROUND} for a fully round shape.`,
      '',
      'If it is a card corner, use 12 (theme.borderRadius.rounded12).',
      'If it is a circle or a pill, declare the width/height in the same style',
      `block (${DIMENSION_KEYS.join(' / ')} equal to the radius or twice it).`,
      '',
    ].join('\n'),
  )
  process.exit(1)
}

main()
