/**
 * Unit tests for {@link getLocaleNumberSymbols} — the entry point that probes
 * a BCP-47 tag for its decimal/group separators.
 *
 * Two paths to exercise:
 * - Fast path: `Intl.NumberFormat.prototype.formatToParts` is available (node,
 *   modern browsers, Hermes iOS).
 * - Fallback path: `formatToParts` is missing (Hermes Android). We simulate
 *   this by deleting the prototype method for the duration of a test and
 *   verify the function still returns correct separators for every supported
 *   app locale by parsing `.format()` output.
 */

import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {getLocaleNumberSymbols} from '../../i18n/number-format'

const SUPPORTED_TAGS = [
  'en-US',
  'de-DE',
  'es-ES',
  'fr-FR',
  'id-ID',
  'ja-JP',
  'ko-KR',
  'pt-BR',
  'ru-RU',
  'vi-VN',
  'zh-CN',
  'zh-TW',
] as const

type Tag = (typeof SUPPORTED_TAGS)[number]

// Expected separators across all 12 supported app locales. Both whitespace
// groupings use explicit Unicode escapes so copy-paste can't silently collapse
// U+202F / U+00A0 into a regular space.
const EXPECTED: Array<[Tag, string, string]> = [
  ['en-US', '.', ','],
  ['de-DE', ',', '.'],
  ['es-ES', ',', '.'],
  ['fr-FR', ',', '\u202F'], // narrow NBSP
  ['id-ID', ',', '.'],
  ['ja-JP', '.', ','],
  ['ko-KR', '.', ','],
  ['pt-BR', ',', '.'],
  ['ru-RU', ',', '\u00A0'], // NBSP
  ['vi-VN', ',', '.'],
  ['zh-CN', '.', ','],
  ['zh-TW', '.', ','],
]

describe('getLocaleNumberSymbols — fast path (formatToParts available)', () => {
  for (const [tag, decimal, group] of EXPECTED) {
    it(`${tag}: decimal=${JSON.stringify(decimal)} group=${JSON.stringify(group)}`, () => {
      expect(getLocaleNumberSymbols(tag)).toEqual({decimal, group})
    })
  }
})

describe('getLocaleNumberSymbols — Hermes-Android fallback (no formatToParts)', () => {
  // biome-ignore lint/suspicious/noExplicitAny: stashing the prototype method for restoration
  let original: any

  beforeEach(() => {
    // Simulate a runtime where Intl.NumberFormat.prototype.formatToParts is
    // not a function — which is how Hermes ships on Android. We delete it
    // from the prototype so the `typeof nf.formatToParts === 'function'`
    // check in getLocaleNumberSymbols short-circuits to the fallback branch.
    original = Intl.NumberFormat.prototype.formatToParts
    // @ts-expect-error — intentionally clearing the method for this test
    Intl.NumberFormat.prototype.formatToParts = undefined
  })

  afterEach(() => {
    Intl.NumberFormat.prototype.formatToParts = original
  })

  for (const [tag, decimal, group] of EXPECTED) {
    it(`${tag}: decimal=${JSON.stringify(decimal)} group=${JSON.stringify(group)}`, () => {
      expect(getLocaleNumberSymbols(tag)).toEqual({decimal, group})
    })
  }

  it('returns identical output to the fast path for every supported locale', () => {
    // Re-enable the real method, capture, disable, capture again, compare.
    Intl.NumberFormat.prototype.formatToParts = original
    const fast = SUPPORTED_TAGS.map((tag) => [tag, getLocaleNumberSymbols(tag)] as const)

    // @ts-expect-error — re-clearing for the fallback capture
    Intl.NumberFormat.prototype.formatToParts = undefined
    const slow = SUPPORTED_TAGS.map((tag) => [tag, getLocaleNumberSymbols(tag)] as const)

    expect(slow).toEqual(fast)
  })
})

describe('getLocaleNumberSymbols — non-app locale', () => {
  // Structurally-valid tag not in SUPPORTED_LOCALES; Intl resolves it (Swiss
  // German uses apostrophe for grouping) — demonstrates the function works
  // beyond the 12 app tags and never returns empty strings.
  it('de-CH: resolves valid unsupported tag without throwing', () => {
    expect(() => getLocaleNumberSymbols('de-CH')).not.toThrow()
    const result = getLocaleNumberSymbols('de-CH')
    expect(result.decimal.length).toBeGreaterThan(0)
    expect(result.group.length).toBeGreaterThan(0)
  })
})
