/**
 * Cross-locale test suite — verifies Intl integration produces the expected
 * output for each of the 12 supported app locales.
 *
 * Behavior tests (precision, empty state, trimming rules) live in
 * {@link ./number-format-parse.test.ts} and {@link ./number-format-display.test.ts}
 * and pin to en-US. This file is the "is the plumbing wired up" check.
 *
 * Note: exact output depends on the ICU version bundled with the JS runtime.
 * Assertions were captured from the same Node/Bun version vitest runs against.
 */

import {describe, expect, it} from 'vitest'
import {
  formatCrypto,
  formatFiat,
  formatPercent,
  type NumberLocale,
  parseNumberFromText,
  renderSubscriptCompressedFromDecimal,
  resolveNumberLocale,
} from '../../i18n/number-format'

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

const locales: Record<(typeof SUPPORTED_TAGS)[number], NumberLocale> = Object.fromEntries(
  SUPPORTED_TAGS.map((tag) => [tag, resolveNumberLocale(tag)]),
) as Record<(typeof SUPPORTED_TAGS)[number], NumberLocale>

describe('resolveNumberLocale — separator families', () => {
  const cases: Array<[(typeof SUPPORTED_TAGS)[number], string, string]> = [
    // tag, decimal, group
    ['en-US', '.', ','],
    ['de-DE', ',', '.'],
    ['es-ES', ',', '.'],
    ['fr-FR', ',', ' '], // narrow NBSP
    ['id-ID', ',', '.'],
    ['ja-JP', '.', ','],
    ['ko-KR', '.', ','],
    ['pt-BR', ',', '.'],
    ['ru-RU', ',', ' '], // NBSP
    ['vi-VN', ',', '.'],
    ['zh-CN', '.', ','],
    ['zh-TW', '.', ','],
  ]

  for (const [tag, decimal, group] of cases) {
    it(`${tag}: decimal=${JSON.stringify(decimal)} group=${JSON.stringify(group)}`, () => {
      const l = resolveNumberLocale(tag)
      expect(l.decimal).toBe(decimal)
      expect(l.group).toBe(group)
    })
  }
})

describe('formatCrypto — plain format across locales', () => {
  // Value: 1234.56 ADA (bigint 1_234_560_000 at decimals=6)
  const value = 1_234_560_000n
  const opts = (tag: (typeof SUPPORTED_TAGS)[number]) => ({decimals: 6, locale: locales[tag]})

  const cases: Array<[(typeof SUPPORTED_TAGS)[number], string]> = [
    ['en-US', '1,234.56'],
    ['de-DE', '1.234,56'],
    // es-ES does NOT group 4-digit numbers per RAE convention — see the
    // dedicated "Spanish grouping quirk" block below.
    ['es-ES', '1234,56'],
    ['fr-FR', '1 234,56'],
    ['id-ID', '1.234,56'],
    ['ja-JP', '1,234.56'],
    ['ko-KR', '1,234.56'],
    ['pt-BR', '1.234,56'],
    ['ru-RU', '1 234,56'],
    ['vi-VN', '1.234,56'],
    ['zh-CN', '1,234.56'],
    ['zh-TW', '1,234.56'],
  ]

  for (const [tag, expected] of cases) {
    it(`${tag}: ${JSON.stringify(expected)}`, () => {
      expect(formatCrypto(value, opts(tag))).toBe(expected)
    })
  }
})

describe('formatFiat — currency placement per locale', () => {
  const value = 1234.56

  describe('USD', () => {
    const cases: Array<[(typeof SUPPORTED_TAGS)[number], string]> = [
      ['en-US', '$1,234.56'],
      ['de-DE', '1.234,56 $'],
      ['fr-FR', '1 234,56 $'],
      ['ja-JP', '$1,234.56'],
      ['pt-BR', '$ 1.234,56'],
      ['ru-RU', '1 234,56 $'],
    ]
    for (const [tag, expected] of cases) {
      it(`${tag}: ${JSON.stringify(expected)}`, () => {
        expect(formatFiat(value, {currency: 'USD', locale: locales[tag]})).toBe(expected)
      })
    }
  })

  describe('EUR', () => {
    const cases: Array<[(typeof SUPPORTED_TAGS)[number], string]> = [
      ['en-US', '€1,234.56'],
      ['de-DE', '1.234,56 €'],
      ['fr-FR', '1 234,56 €'],
    ]
    for (const [tag, expected] of cases) {
      it(`${tag}: ${JSON.stringify(expected)}`, () => {
        expect(formatFiat(value, {currency: 'EUR', locale: locales[tag]})).toBe(expected)
      })
    }
  })

  describe('JPY (zero-decimal)', () => {
    // JPY has no fractional digits by convention — Intl honors this automatically.
    // The yen glyph comes from the curated FIAT_SYMBOLS table (half-width `¥`,
    // matching the Settings picker) rather than Intl's locale-specific narrow
    // symbol, which on ja-JP would yield the full-width `￥` (U+FFE5).
    it('ja-JP uses the curated half-width yen', () => {
      expect(formatFiat(1234, {currency: 'JPY', locale: locales['ja-JP']})).toBe('¥1,234')
    })

    it('en-US uses regular yen', () => {
      expect(formatFiat(1234, {currency: 'JPY', locale: locales['en-US']})).toBe('¥1,234')
    })
  })
})

describe('formatCrypto — compact abbreviation per locale', () => {
  // 1_500_000 ADA as atomic units (decimals=6)
  const value = 1_500_000_000_000n

  const cases: Array<[(typeof SUPPORTED_TAGS)[number], string]> = [
    ['en-US', '1.5M'],
    ['de-DE', '1,5 Mio.'],
    ['fr-FR', '1,5 M'],
    ['ja-JP', '150万'],
    ['ko-KR', '150만'],
    ['zh-CN', '150万'],
    ['zh-TW', '150萬'],
    ['pt-BR', '1,5 mi'],
    ['ru-RU', '1,5 млн'],
    ['id-ID', '1,5 jt'],
    ['vi-VN', '1,5 Tr'],
  ]

  for (const [tag, expected] of cases) {
    it(`${tag}: ${JSON.stringify(expected)}`, () => {
      expect(formatCrypto(value, {decimals: 6, locale: locales[tag], abbreviate: true})).toBe(expected)
    })
  }
})

describe('formatPercent — spacing convention per locale', () => {
  // DE/FR/RU put a non-breaking space before %; en/JP/KR/ZH/VN/PT don't.
  const cases: Array<[(typeof SUPPORTED_TAGS)[number], string]> = [
    ['en-US', '12.34%'],
    ['de-DE', '12,34 %'],
    ['fr-FR', '12,34 %'],
    ['ja-JP', '12.34%'],
    ['ko-KR', '12.34%'],
    ['zh-CN', '12.34%'],
    ['ru-RU', '12,34 %'],
    ['pt-BR', '12,34%'],
  ]

  for (const [tag, expected] of cases) {
    it(`${tag}: ${JSON.stringify(expected)}`, () => {
      expect(formatPercent(0.1234, {locale: locales[tag]})).toBe(expected)
    })
  }
})

describe('formatPercent — asPercent + Hermes percent-style regression', () => {
  // Pins the post-fix contract for the exact value from the iOS Hermes
  // priceImpact-of-1.09 bug report: scaling and locale-correct decimal must
  // survive on every supported locale (the previous Intl `style: 'percent'`
  // path silently rounded the percent value to whole-integer on Hermes).
  const NBSP = ' '
  const cases: Array<[(typeof SUPPORTED_TAGS)[number], string]> = [
    ['en-US', '1.09%'],
    ['de-DE', `1,09${NBSP}%`],
    ['fr-FR', `1,09${NBSP}%`],
    ['ja-JP', '1.09%'],
    ['ko-KR', '1.09%'],
    ['zh-CN', '1.09%'],
    ['ru-RU', `1,09${NBSP}%`],
    ['pt-BR', '1,09%'],
  ]

  for (const [tag, expected] of cases) {
    it(`${tag}: ${JSON.stringify(expected)}`, () => {
      expect(formatPercent(1.09, {locale: locales[tag], asPercent: true, fractionDigits: 2})).toBe(expected)
    })
  }
})

describe('subscript composition — uses locale decimal separator', () => {
  // 0.00000862 — 5 leading zeros → subscript ₅ (total-zero count)
  const DECIMAL_STR = '0.00000862'

  const cases: Array<[(typeof SUPPORTED_TAGS)[number], string]> = [
    ['en-US', '0.0₅862'],
    ['de-DE', '0,0₅862'],
    ['fr-FR', '0,0₅862'],
    ['ja-JP', '0.0₅862'],
    ['ko-KR', '0.0₅862'],
    ['pt-BR', '0,0₅862'],
    ['ru-RU', '0,0₅862'],
  ]

  for (const [tag, expected] of cases) {
    it(`${tag}: ${JSON.stringify(expected)}`, () => {
      expect(renderSubscriptCompressedFromDecimal(DECIMAL_STR, locales[tag])).toBe(expected)
    })
  }
})

describe('subscript inside currency frame', () => {
  // formatFiat with subscript — ensures currency symbol placement is preserved
  // and the number body is swapped in place.
  const tiny = 0.00000862

  const cases: Array<[(typeof SUPPORTED_TAGS)[number], string]> = [
    ['en-US', '$0.0₅862'],
    ['de-DE', '0,0₅862 $'],
    ['fr-FR', '0,0₅862 $'],
    ['ja-JP', '$0.0₅862'],
    ['ru-RU', '0,0₅862 $'],
  ]

  for (const [tag, expected] of cases) {
    it(`${tag}: ${JSON.stringify(expected)}`, () => {
      expect(formatFiat(tiny, {currency: 'USD', locale: locales[tag], subscript: true})).toBe(expected)
    })
  }
})

describe('parseNumberFromText — NBSP paste handling across locales', () => {
  // A fr-FR user pastes a locally-formatted number like "1 234,56" (narrow NBSP).
  // All locales should parse the same canonical value once the NBSP is stripped.
  const tests: Array<[(typeof SUPPORTED_TAGS)[number], string, bigint]> = [
    ['fr-FR', '1 234,56', 1_234_560_000n],
    ['ru-RU', '1 234,56', 1_234_560_000n],
    // Cross-locale: pasting fr-FR input into en-US should still resolve.
    ['en-US', '1 234,56', 1_234_560_000n],
    // Plain-space grouping, any locale: treated as grouping.
    ['en-US', '1 234.56', 1_234_560_000n],
  ]

  for (const [tag, text, expected] of tests) {
    it(`${tag}: parse(${JSON.stringify(text)}) → ${expected}n`, () => {
      const r = parseNumberFromText(text, {decimals: 6, locale: locales[tag]})
      expect(r.canonical).toBe(expected)
    })
  }
})

describe('Spanish grouping quirk — 4-digit numbers not grouped', () => {
  // es-ES Intl does NOT group numbers < 10,000 (per RAE convention).
  // formatCrypto should honor this automatically via Intl/BigNumber.
  it('es-ES: 1234.56 → "1234,56" (no group)', () => {
    expect(formatCrypto(1_234_560_000n, {decimals: 6, locale: locales['es-ES']})).toBe('1234,56')
  })

  it('es-ES: 12345.67 → "12.345,67" (grouped)', () => {
    expect(formatCrypto(12_345_670_000n, {decimals: 6, locale: locales['es-ES']})).toBe('12.345,67')
  })
})
