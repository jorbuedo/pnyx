/**
 * Unit tests for parseNumberFromText — the user-input parser.
 *
 * Organized by:
 *  1. Baseline (empty, zero, trivial integers)
 *  2. Single-separator typing (keyboard/locale match and mismatch)
 *  3. Two-separator paste (cross-locale interpretation)
 *  4. Multi-separator edge cases
 *  5. Trailing separator mid-typing
 *  6. Leading decimal
 *  7. Precision / truncation
 *  8. Whitespace grouping (fr-FR, ru-RU)
 *  9. Noise stripping (currency symbols, letters, non-Latin digits)
 * 10. Output contract (inputValue vs canonicalStr vs canonical)
 * 11. Roundtrip property: parse(inputValue) yields the same canonical
 */

import {describe, expect, it} from 'vitest'
import {
  EN_US_NUMBER_LOCALE,
  type NumberLocale,
  parseNumberFromText,
  resolveNumberLocale,
} from '../../i18n/number-format'

const EN_US = EN_US_NUMBER_LOCALE
const DE_DE: NumberLocale = {tag: 'de-DE', decimal: ',', group: '.', groupSize: 3}
const FR_FR: NumberLocale = {tag: 'fr-FR', decimal: ',', group: ' ', groupSize: 3}
const JA_JP: NumberLocale = {tag: 'ja-JP', decimal: '.', group: ',', groupSize: 3}

const parse = (text: string, locale: NumberLocale, decimals = 6, precision?: number) =>
  parseNumberFromText(text, precision !== undefined ? {decimals, locale, precision} : {decimals, locale})

describe('parseNumberFromText — baseline', () => {
  it('empty string returns empty result', () => {
    const r = parse('', EN_US)
    expect(r).toEqual({inputValue: '', canonicalStr: '0', canonical: 0n, isEmpty: true})
  })

  it('whitespace-only input is treated as empty', () => {
    expect(parse('   ', EN_US).isEmpty).toBe(true)
    expect(parse('  ', EN_US).isEmpty).toBe(true)
  })

  it('single digit returns that digit', () => {
    expect(parse('7', EN_US)).toMatchObject({inputValue: '7', canonicalStr: '7', canonical: 7_000_000n})
  })

  it('multi-digit integer without separators', () => {
    expect(parse('1234', EN_US)).toMatchObject({inputValue: '1234', canonicalStr: '1234', canonical: 1_234_000_000n})
  })

  it('strips redundant leading zeros', () => {
    expect(parse('007', EN_US)).toMatchObject({inputValue: '7', canonical: 7_000_000n})
    expect(parse('0012.5', EN_US)).toMatchObject({inputValue: '12.5', canonical: 12_500_000n})
  })

  it('preserves single leading zero before decimal', () => {
    expect(parse('0.5', EN_US)).toMatchObject({inputValue: '0.5', canonical: 500_000n})
  })

  it('handles plain "0" input', () => {
    expect(parse('0', EN_US)).toMatchObject({inputValue: '0', canonicalStr: '0', canonical: 0n, isEmpty: false})
  })
})

describe('parseNumberFromText — single-separator typing (keyboard match)', () => {
  it('en-US: typed "." is the decimal', () => {
    expect(parse('1.5', EN_US)).toMatchObject({inputValue: '1.5', canonicalStr: '1.5', canonical: 1_500_000n})
  })

  it('de-DE: typed "," is the decimal', () => {
    // `canonicalStr` is always `.`-decimal for parent state / API calls.
    expect(parse('1,5', DE_DE)).toMatchObject({inputValue: '1,5', canonicalStr: '1.5', canonical: 1_500_000n})
  })

  it('fr-FR: typed "," is the decimal', () => {
    expect(parse('1,5', FR_FR)).toMatchObject({inputValue: '1,5', canonicalStr: '1.5', canonical: 1_500_000n})
  })

  it('ja-JP: typed "." is the decimal', () => {
    expect(parse('1.5', JA_JP)).toMatchObject({inputValue: '1.5', canonicalStr: '1.5', canonical: 1_500_000n})
  })
})

describe('parseNumberFromText — single-separator typing (keyboard mismatch)', () => {
  it('de-DE: typed "." on US keyboard becomes "," in output', () => {
    const r = parse('1.5', DE_DE)
    expect(r.inputValue).toBe('1,5')
    expect(r.canonical).toBe(1_500_000n)
  })

  it('en-US: typed "," on DE keyboard becomes "." in output', () => {
    const r = parse(',5', EN_US)
    expect(r.inputValue).toBe('0.5')
    expect(r.canonical).toBe(500_000n)
  })

  it('keyboard mismatch works with multi-digit fractional', () => {
    expect(parse('12.3456', DE_DE).inputValue).toBe('12,3456')
    expect(parse('12,3456', EN_US).inputValue).toBe('12.3456')
  })
})

describe('parseNumberFromText — two-separator paste (cross-locale)', () => {
  // US-formatted pasted: "1,234.56" → 1234.56 in ALL locales
  it('"1,234.56" resolves to 1234.56 in en-US', () => {
    expect(parse('1,234.56', EN_US).canonical).toBe(1_234_560_000n)
  })

  it('"1,234.56" resolves to 1234.56 in de-DE (NOT 1.23456)', () => {
    const r = parse('1,234.56', DE_DE)
    expect(r.canonical).toBe(1_234_560_000n)
    expect(r.inputValue).toBe('1234,56')
  })

  it('"1,234.56" resolves to 1234.56 in fr-FR', () => {
    expect(parse('1,234.56', FR_FR).canonical).toBe(1_234_560_000n)
  })

  // DE-formatted pasted: "1.234,56" → 1234.56 in ALL locales
  it('"1.234,56" resolves to 1234.56 in en-US', () => {
    const r = parse('1.234,56', EN_US)
    expect(r.canonical).toBe(1_234_560_000n)
    expect(r.inputValue).toBe('1234.56')
  })

  it('"1.234,56" resolves to 1234.56 in de-DE', () => {
    expect(parse('1.234,56', DE_DE).canonical).toBe(1_234_560_000n)
  })

  it('symmetric: US and DE pastes produce identical canonical in DE locale', () => {
    const a = parse('1,234.56', DE_DE)
    const b = parse('1.234,56', DE_DE)
    expect(a.canonical).toBe(b.canonical)
    expect(a.inputValue).toBe(b.inputValue)
  })

  it('multiple groupings handled: "1,234,567.89"', () => {
    expect(parse('1,234,567.89', EN_US).canonical).toBe(1_234_567_890_000n)
    expect(parse('1.234.567,89', DE_DE).canonical).toBe(1_234_567_890_000n)
  })
})

describe('parseNumberFromText — multi-separator edge cases', () => {
  it('only-comma paste with multiple "," is grouping (not repeated decimals)', () => {
    expect(parse('1,234,567', EN_US)).toMatchObject({
      inputValue: '1234567',
      canonical: 1_234_567_000_000n,
    })
  })

  it('only-period paste with multiple "." is grouping (DE-style thousands)', () => {
    expect(parse('1.234.567', DE_DE)).toMatchObject({
      inputValue: '1234567',
      canonical: 1_234_567_000_000n,
    })
  })

  it('only-period paste with multiple "." in en-US is treated as grouping too', () => {
    // User pastes a DE-formatted integer into en-US. We treat as grouping since
    // count>1 can never be repeated decimals.
    expect(parse('1.234.567', EN_US).canonical).toBe(1_234_567_000_000n)
  })

  it('paste "123.45.67" (typo) — invalid grouping pattern, last separator wins as decimal', () => {
    // segments after first [45, 67] are not 3 digits → fall through to
    // last-wins (decimalChar='.'). "123.45" becomes the integer, "67" the
    // fractional part → 12345.67.
    const r = parse('123.45.67', EN_US)
    expect(r.canonical).toBe(12_345_670_000n)
    expect(r.canonicalStr).toBe('12345.67')
  })

  it('paste "1.234.5678" (invalid grouping, 4-digit tail) → last wins', () => {
    const r = parse('1.234.5678', EN_US)
    // segment "5678" is 4 digits → not valid grouping → last `.` = decimal
    expect(r.canonicalStr).toBe('1234.5678')
  })

  it('paste "1.234.5" (invalid grouping, 1-digit tail) → last wins', () => {
    // Last segment "5" has 1 digit, not exactly 3 → not valid grouping.
    // Last `.` becomes decimal → "1234.5".
    expect(parse('1.234.5', EN_US).canonicalStr).toBe('1234.5')
  })

  it('paste "1.234.567.890" — three valid-width groups → all grouping', () => {
    const r = parse('1.234.567.890', EN_US)
    expect(r.canonicalStr).toBe('1234567890')
  })

  it('preserves trailing zeros in fractional part "55.0"', () => {
    const r = parse('55.0', EN_US)
    expect(r.inputValue).toBe('55.0')
    expect(r.canonicalStr).toBe('55.0')
    expect(r.canonical).toBe(55_000_000n)
  })

  it('preserves trailing zeros "1.100"', () => {
    const r = parse('1.100', EN_US)
    expect(r.inputValue).toBe('1.100')
    expect(r.canonicalStr).toBe('1.100')
    expect(r.canonical).toBe(1_100_000n)
  })
})

describe('parseNumberFromText — trailing separator mid-typing', () => {
  it('en-US: "12." keeps trailing "." in inputValue, strips in canonicalStr', () => {
    const r = parse('12.', EN_US)
    expect(r.inputValue).toBe('12.')
    expect(r.canonicalStr).toBe('12')
    expect(r.canonical).toBe(12_000_000n)
    expect(r.isEmpty).toBe(false)
  })

  it('de-DE: "12," keeps trailing "," in inputValue', () => {
    const r = parse('12,', DE_DE)
    expect(r.inputValue).toBe('12,')
    expect(r.canonicalStr).toBe('12')
  })

  it('de-DE: typed "12." on US keyboard still produces trailing "," (mismatch)', () => {
    const r = parse('12.', DE_DE)
    expect(r.inputValue).toBe('12,')
    expect(r.canonicalStr).toBe('12')
    expect(r.canonical).toBe(12_000_000n)
  })

  it('en-US: typed "," alone becomes "0."', () => {
    const r = parse(',', EN_US)
    expect(r.inputValue).toBe('0.')
    expect(r.canonicalStr).toBe('0')
  })

  it('single decimal "." on empty field becomes "0."', () => {
    const r = parse('.', EN_US)
    expect(r.inputValue).toBe('0.')
    expect(r.canonical).toBe(0n)
  })
})

describe('parseNumberFromText — leading decimal', () => {
  it('".45" in en-US becomes "0.45"', () => {
    expect(parse('.45', EN_US)).toMatchObject({inputValue: '0.45', canonical: 450_000n})
  })

  it('",45" in de-DE becomes "0,45"', () => {
    expect(parse(',45', DE_DE)).toMatchObject({inputValue: '0,45', canonical: 450_000n})
  })

  it('",45" in en-US (mismatch) also becomes "0.45"', () => {
    expect(parse(',45', EN_US)).toMatchObject({inputValue: '0.45', canonical: 450_000n})
  })
})

describe('parseNumberFromText — precision / truncation', () => {
  it('truncates fractional digits beyond decimals', () => {
    // decimals=6, user types 7 fractional digits
    expect(parse('1.1234567', EN_US).inputValue).toBe('1.123456')
    expect(parse('1.1234567', EN_US).canonical).toBe(1_123_456n)
  })

  it('truncates, never rounds', () => {
    // decimals=2, input 1.999 — result must be 1.99 not 2.00
    expect(parse('1.999', EN_US, 2)).toMatchObject({inputValue: '1.99', canonical: 199n})
    expect(parse('1.9999999', EN_US, 2)).toMatchObject({inputValue: '1.99', canonical: 199n})
  })

  it('precision override is respected', () => {
    // decimals=18 (ETH), but precision capped at 2
    expect(parse('1.234', EN_US, 18, 2)).toMatchObject({inputValue: '1.23'})
  })

  it('fewer digits than precision does not pad', () => {
    expect(parse('1.5', EN_US, 6).inputValue).toBe('1.5')
  })
})

describe('parseNumberFromText — whitespace grouping', () => {
  it('fr-FR: "1 234,56" with NBSP is parsed correctly', () => {
    expect(parse('1 234,56', FR_FR).canonical).toBe(1_234_560_000n)
  })

  it('fr-FR: "1 234,56" with narrow NBSP is parsed correctly', () => {
    expect(parse('1 234,56', FR_FR).canonical).toBe(1_234_560_000n)
  })

  it('any locale: plain space as grouping is stripped', () => {
    expect(parse('1 234 567.89', EN_US).canonical).toBe(1_234_567_890_000n)
  })
})

describe('parseNumberFromText — noise stripping', () => {
  it('strips currency symbols', () => {
    expect(parse('$1,234.56', EN_US).canonical).toBe(1_234_560_000n)
    expect(parse('1.234,56 €', DE_DE).canonical).toBe(1_234_560_000n)
    expect(parse('¥1234', JA_JP).canonical).toBe(1_234_000_000n)
  })

  it('strips alphabetic noise', () => {
    expect(parse('abc1.5def', EN_US).canonical).toBe(1_500_000n)
  })

  it('strips negative signs (negative input unsupported)', () => {
    expect(parse('-1.5', EN_US).canonical).toBe(1_500_000n)
  })

  it('strips non-Latin digits (unsupported)', () => {
    // Arabic-Indic digits ١٢٣ are discarded — only ASCII 0-9 supported.
    expect(parse('١٢٣.5', EN_US).canonical).toBe(500_000n)
  })

  it('strips scientific notation characters', () => {
    // "1e5" → "15" after stripping 'e', which yields canonical 15
    expect(parse('1e5', EN_US).canonical).toBe(15_000_000n)
  })
})

describe('parseNumberFromText — output contract', () => {
  it('inputValue and canonicalStr identical when no trailing separator', () => {
    const r = parse('1.5', EN_US)
    expect(r.inputValue).toBe(r.canonicalStr)
  })

  it('canonicalStr has no thousands grouping', () => {
    const r = parse('1234567.89', EN_US)
    expect(r.canonicalStr).toBe('1234567.89')
    expect(r.canonicalStr).not.toContain(',')
  })

  it('canonical reflects the effective value regardless of textual form', () => {
    // Several textual forms that all mean 1234.56
    const forms = ['1234.56', '1,234.56', '1.234,56']
    const canonicals = forms.map((t) => parse(t, DE_DE).canonical)
    expect(new Set(canonicals).size).toBe(1)
    expect(canonicals[0]).toBe(1_234_560_000n)
  })

  it('isEmpty is true only for empty/noise-only inputs', () => {
    expect(parse('', EN_US).isEmpty).toBe(true)
    expect(parse('abc', EN_US).isEmpty).toBe(true)
    expect(parse('0', EN_US).isEmpty).toBe(false)
    expect(parse('.', EN_US).isEmpty).toBe(false)
  })
})

describe('parseNumberFromText — roundtrip property', () => {
  // For every locale, re-parsing the `inputValue` yields the same canonical.
  const locales = [EN_US, DE_DE, FR_FR, JA_JP]

  for (const locale of locales) {
    describe(`locale=${locale.tag}`, () => {
      const samples = ['1', '1.5', '0.5', '1234.5678', '1234567.89', '0', '0.001', '999.999999']

      for (const text of samples) {
        it(`roundtrip "${text}"`, () => {
          const first = parse(text, locale, 6)
          const second = parse(first.inputValue, locale, 6)
          expect(second.canonical).toBe(first.canonical)
          expect(second.inputValue).toBe(first.inputValue)
        })
      }
    })
  }
})

describe('resolveNumberLocale', () => {
  it('returns en-US conventions for "en-US"', () => {
    const r = resolveNumberLocale('en-US')
    expect(r).toMatchObject({tag: 'en-US', decimal: '.', group: ',', groupSize: 3})
  })

  it('returns DE conventions for "de-DE"', () => {
    const r = resolveNumberLocale('de-DE')
    expect(r).toMatchObject({tag: 'de-DE', decimal: ',', group: '.', groupSize: 3})
  })

  it('returns CJK conventions (`,` group, `.` decimal) for "ja-JP"', () => {
    const r = resolveNumberLocale('ja-JP')
    expect(r).toMatchObject({tag: 'ja-JP', decimal: '.', group: ','})
  })

  it('handles fr-FR NBSP grouping', () => {
    const r = resolveNumberLocale('fr-FR')
    expect(r.decimal).toBe(',')
    // fr-FR uses narrow NBSP (U+202F) or regular NBSP (U+00A0) depending on Intl impl
    expect(/\s/.test(r.group)).toBe(true)
  })
})
