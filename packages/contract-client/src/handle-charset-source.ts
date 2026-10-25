// The derivation behind `handle-charset.ts`'s pinned tables, kept **pure** and separate.
//
// ⚠️ Separate because the generator writes a source file, and the drift test has to import the
// derivation without triggering that. A first version put both in the script; importing it from the
// test rewrote `handle-charset.ts` mid-run, so the suite failed once and passed on every rerun.
import {
  ALLOWED_CODE_POINT_EXCEPTIONS,
  DENIED_EXTRA_CODE_POINTS,
  DENIED_PROPERTIES,
  type HandleRange,
} from './handle-charset.js'

export const MAX_CODE_POINT = 0x10ffff

const deniedRe = new RegExp(`[${DENIED_PROPERTIES.map((p) => `\\p{${p}}`).join('')}]`, 'u')
const extra = new Set(DENIED_EXTRA_CODE_POINTS)
const kept = new Set(ALLOWED_CODE_POINT_EXCEPTIONS)

/** The live property test — the authority the pinned tables are generated from and checked against. */
export const isDeniedByProperty = (cp: number): boolean => {
  if (kept.has(cp)) return false
  return extra.has(cp) || deniedRe.test(String.fromCodePoint(cp))
}

export const rangesFor = (predicate: (cp: number) => boolean): readonly HandleRange[] => {
  const out: HandleRange[] = []
  let start = -1
  for (let cp = 0; cp <= MAX_CODE_POINT; cp++) {
    if (predicate(cp)) {
      if (start === -1) start = cp
    } else if (start !== -1) {
      out.push([start, cp - 1])
      start = -1
    }
  }
  if (start !== -1) out.push([start, MAX_CODE_POINT])
  return out
}

const markRe = /\p{M}/u
const nonspacingRe = /\p{Mn}/u

export const CHARSET_TABLES = {
  denied: () => rangesFor(isDeniedByProperty),
  marks: () => rangesFor((cp) => !isDeniedByProperty(cp) && markRe.test(String.fromCodePoint(cp))),
  nonspacing: () => rangesFor((cp) => !isDeniedByProperty(cp) && nonspacingRe.test(String.fromCodePoint(cp))),
}

export const pack = (ranges: readonly HandleRange[]): string =>
  ranges.map(([a, b]) => (a === b ? a.toString(16) : `${a.toString(16)}-${b.toString(16)}`)).join(',')
