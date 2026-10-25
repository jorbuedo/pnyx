/**
 * Tests for `formatLocalizedNumber` (number + bigint paths) and parity with
 * `formatCrypto`. Covers the consolidation where both functions now route
 * through the shared `formatPlain` core, so the bigint overload of
 * `formatLocalizedNumber` must produce identical output to `formatCrypto`'s
 * plain path for the same inputs.
 */

import {describe, expect, it} from 'vitest'
import {
  EN_US_NUMBER_LOCALE,
  formatCrypto,
  formatFiat,
  formatLocalizedNumber,
  getCurrencyAffix,
  getCurrencySymbol,
  type NumberLocale,
  resolveNumberLocale,
} from './number-format'

const EN_US = EN_US_NUMBER_LOCALE
const DE_DE: NumberLocale = resolveNumberLocale('de-DE')
const FR_FR: NumberLocale = resolveNumberLocale('fr-FR')
const ES_ES: NumberLocale = resolveNumberLocale('es-ES')
const JA_JP: NumberLocale = resolveNumberLocale('ja-JP')

describe('getCurrencySymbol / getCurrencyAffix — glyph contract', () => {
  // The settings currency picker renders getCurrencySymbol; formatFiat renders
  // the amount. Both must resolve the same glyph so the picker shows exactly
  // what a balance will display.
  it('uses the curated FIAT_SYMBOLS glyph for every supported fiat', () => {
    expect(getCurrencySymbol('USD', EN_US)).toBe('$')
    expect(getCurrencySymbol('EUR', EN_US)).toBe('€')
    expect(getCurrencySymbol('GBP', EN_US)).toBe('£')
    expect(getCurrencySymbol('JPY', EN_US)).toBe('¥')
    expect(getCurrencySymbol('MXN', EN_US)).toBe('$')
    expect(getCurrencySymbol('CNY', EN_US)).toBe('¥')
    expect(getCurrencySymbol('SEK', EN_US)).toBe('kr')
    expect(getCurrencySymbol('CAD', EN_US)).toBe('C$')
    expect(getCurrencySymbol('AUD', EN_US)).toBe('A$')
    expect(getCurrencySymbol('SGD', EN_US)).toBe('S$')
    expect(getCurrencySymbol('CHF', EN_US)).toBe('Fr')
    expect(getCurrencySymbol('CAD', DE_DE)).toBe('C$') // glyph is locale-independent
  })

  it('overrides Intl when narrowSymbol falls back to the ISO code', () => {
    // de-CH + EUR is the reproducer on V8: Intl narrowSymbol returns the bare
    // "EUR" code because Swiss German has no narrow glyph for the Euro. The
    // same class of fallback occurs on some Hermes builds for fr-FR + USD,
    // ja-JP + GBP, etc., which is what QA hit in the field. The curated
    // FIAT_SYMBOLS table must take over so users see "€" not "EUR".
    const DE_CH = resolveNumberLocale('de-CH')
    expect(getCurrencySymbol('EUR', DE_CH)).toBe('€')
    expect(getCurrencyAffix('EUR', DE_CH).symbol).toBe('€')
    const rendered = formatFiat(1, {currency: 'EUR', locale: DE_CH})
    expect(rendered).toContain('€')
    expect(rendered).not.toContain('EUR')
  })

  it('matches the glyph formatFiat actually renders (picker == balance)', () => {
    for (const code of ['USD', 'MXN', 'CNY', 'SEK', 'CAD', 'AUD', 'SGD', 'CHF']) {
      expect(formatFiat(1234.5, {currency: code, locale: EN_US})).toContain(getCurrencySymbol(code, EN_US))
    }
  })

  it('reports locale-correct placement', () => {
    expect(getCurrencyAffix('USD', EN_US)).toEqual({symbol: '$', position: 'prefix'})
    expect(getCurrencyAffix('EUR', DE_DE)).toEqual({symbol: '€', position: 'suffix'})
  })

  it('never leaks the country prefix that Intl bakes into compound symbols', () => {
    // The bug: certain locale × currency combinations have Intl emit a
    // compound symbol (`US$`, `JP¥`, `£GB`, `$CA`) instead of the bare glyph.
    // On V8 this surfaces in `currencyDisplay:'symbol'` mode for en-CA / en-GB
    // / es-ES; on Hermes-iOS it surfaces even in `narrowSymbol` mode when the
    // device locale is non-en-US. We never want the country letters in the
    // output — formatFiat builds the digits from a non-currency formatter and
    // attaches the curated FIAT_SYMBOLS glyph, so the prefix can't reach the
    // user.
    const locales = ['en-US', 'en-CA', 'en-GB', 'de-DE', 'de-CH', 'fr-FR', 'es-ES', 'ja-JP', 'pt-BR']
    for (const tag of locales) {
      const loc = resolveNumberLocale(tag)
      for (const display of ['narrowSymbol', 'symbol'] as const) {
        const usd = formatFiat(1234.5, {currency: 'USD', locale: loc, currencyDisplay: display})
        expect(usd, `${tag} USD ${display}`).not.toMatch(/US/)
        expect(usd, `${tag} USD ${display}`).toContain('$')

        const jpy = formatFiat(1234, {currency: 'JPY', locale: loc, currencyDisplay: display})
        expect(jpy, `${tag} JPY ${display}`).not.toMatch(/JP/)
        expect(jpy, `${tag} JPY ${display}`).toContain('¥')
      }
    }
  })

  it('keeps locale-correct compact-notation suffix and minus-sign placement', () => {
    // Compact suffix ("M", "Mio.", "万") and the leading minus sign must
    // survive intact — the override only swaps the symbol, never the body.
    expect(formatFiat(1_500_000, {currency: 'USD', locale: EN_US, abbreviate: true})).toBe('$1.5M')
    expect(formatFiat(1_500_000, {currency: 'USD', locale: DE_DE, abbreviate: true}).replace(/\s/g, ' ')).toMatch(
      /^1,5 Mio\. \$$/,
    )
    expect(formatFiat(-1_500_000, {currency: 'USD', locale: EN_US, abbreviate: true})).toBe('-$1.5M')
    // ja-JP compact uses 万 — the override must not eat or duplicate it.
    const jaCompact = formatFiat(15_000_000, {currency: 'USD', locale: JA_JP, abbreviate: true})
    expect(jaCompact).toContain('$')
    expect(jaCompact).toContain('万')
  })

  it('keeps the override glyph but follows the locale for placement', () => {
    // CAD overrides the glyph to "C$" yet still prefixes on en-US and suffixes
    // on de-DE — the override swaps the symbol, never the placement.
    expect(getCurrencyAffix('CAD', EN_US)).toEqual({symbol: 'C$', position: 'prefix'})
    expect(getCurrencyAffix('CAD', DE_DE)).toEqual({symbol: 'C$', position: 'suffix'})
    expect(formatFiat(1234.5, {currency: 'CAD', locale: EN_US})).toBe('C$1,234.50')
    // de-DE suffixes with a NBSP between number and glyph — normalise to compare.
    expect(formatFiat(1234.5, {currency: 'CAD', locale: DE_DE}).replace(/\s/g, ' ')).toBe('1.234,50 C$')
  })
})

describe('formatLocalizedNumber — number path', () => {
  describe('basic formatting', () => {
    it('formats integer with default fraction settings', () => {
      expect(formatLocalizedNumber(1234, {locale: EN_US})).toBe('1,234')
    })

    it('formats fractional value with default minFrac=0', () => {
      expect(formatLocalizedNumber(1.5, {locale: EN_US})).toBe('1.5')
    })

    it('pads to minFrac', () => {
      expect(formatLocalizedNumber(1.5, {locale: EN_US, minFrac: 4, maxFrac: 6})).toBe('1.5000')
    })

    it('trims trailing zeros above minFrac', () => {
      expect(formatLocalizedNumber(1.5, {locale: EN_US, minFrac: 2, maxFrac: 6})).toBe('1.50')
    })

    it('caps at maxFrac', () => {
      expect(formatLocalizedNumber(1.23456789, {locale: EN_US, maxFrac: 2})).toBe('1.23')
    })

    it('integer-only when maxFrac=0', () => {
      expect(formatLocalizedNumber(1234.567, {locale: EN_US, maxFrac: 0})).toBe('1,235')
    })

    it('integer-only with minFrac=0 strips the decimal', () => {
      expect(formatLocalizedNumber(1234, {locale: EN_US, minFrac: 0, maxFrac: 6})).toBe('1,234')
    })
  })

  describe('zero', () => {
    it('renders 0 with default settings', () => {
      expect(formatLocalizedNumber(0, {locale: EN_US})).toBe('0')
    })

    it('renders 0 with minFrac', () => {
      expect(formatLocalizedNumber(0, {locale: EN_US, minFrac: 2, maxFrac: 2})).toBe('0.00')
    })

    it('renders -0 as 0', () => {
      expect(formatLocalizedNumber(-0, {locale: EN_US, minFrac: 2, maxFrac: 2})).toBe('0.00')
    })
  })

  describe('negative values', () => {
    it('formats negative integer', () => {
      expect(formatLocalizedNumber(-1234, {locale: EN_US})).toBe('-1,234')
    })

    it('formats negative fraction', () => {
      expect(formatLocalizedNumber(-1.5, {locale: EN_US, minFrac: 1, maxFrac: 1})).toBe('-1.5')
    })

    it('formats negative with min/maxFrac', () => {
      expect(formatLocalizedNumber(-1234.567, {locale: EN_US, minFrac: 2, maxFrac: 2})).toBe('-1,234.57')
    })
  })

  describe('non-finite values', () => {
    it('NaN → "0"', () => {
      expect(formatLocalizedNumber(Number.NaN, {locale: EN_US})).toBe('0')
    })

    it('Infinity → "0"', () => {
      expect(formatLocalizedNumber(Number.POSITIVE_INFINITY, {locale: EN_US})).toBe('0')
    })

    it('-Infinity → "0"', () => {
      expect(formatLocalizedNumber(Number.NEGATIVE_INFINITY, {locale: EN_US})).toBe('0')
    })
  })

  describe('rounding (toFixed semantics)', () => {
    // The number path inherits `Number.prototype.toFixed` semantics, which is
    // bound by float64 representation. Values like 1.95 are stored as
    // 1.94999... so they round DOWN — that's a known JS quirk. The bigint
    // path (below) is exact and rounds 1.95 → "2.0" correctly.
    it('1.95 with maxFrac=1 rounds DOWN to "1.9" (float quirk)', () => {
      expect(formatLocalizedNumber(1.95, {locale: EN_US, minFrac: 1, maxFrac: 1})).toBe('1.9')
    })

    it('9.95 with maxFrac=1 rounds DOWN to "9.9" (float quirk)', () => {
      expect(formatLocalizedNumber(9.95, {locale: EN_US, minFrac: 1, maxFrac: 1})).toBe('9.9')
    })

    it('1.94 with maxFrac=1 rounds down to "1.9"', () => {
      expect(formatLocalizedNumber(1.94, {locale: EN_US, minFrac: 1, maxFrac: 1})).toBe('1.9')
    })

    it('2.5 with maxFrac=0 rounds to "3" (exact half, no float drift)', () => {
      // 2.5 has an exact float representation so toFixed rounds half-up.
      expect(formatLocalizedNumber(2.5, {locale: EN_US, maxFrac: 0})).toBe('3')
    })

    it('1.5 with maxFrac=0 rounds to "2" (exact half)', () => {
      expect(formatLocalizedNumber(1.5, {locale: EN_US, maxFrac: 0})).toBe('2')
    })
  })

  describe('locale separators', () => {
    it('de-DE uses "." for grouping and "," for decimal', () => {
      expect(formatLocalizedNumber(1234.56, {locale: DE_DE, minFrac: 2, maxFrac: 2})).toBe('1.234,56')
    })

    it('fr-FR uses NBSP grouping and "," decimal', () => {
      const r = formatLocalizedNumber(1234.56, {locale: FR_FR, minFrac: 2, maxFrac: 2})
      expect(r).toMatch(/^1[  ]234,56$/)
    })

    it('es-ES skips grouping below 10k', () => {
      expect(formatLocalizedNumber(1234.56, {locale: ES_ES, minFrac: 2, maxFrac: 2})).toBe('1234,56')
    })

    it('es-ES groups at and above 10k', () => {
      expect(formatLocalizedNumber(12345.67, {locale: ES_ES, minFrac: 2, maxFrac: 2})).toBe('12.345,67')
    })

    it('ja-JP same separators as en-US', () => {
      expect(formatLocalizedNumber(1234.56, {locale: JA_JP, minFrac: 2, maxFrac: 2})).toBe('1,234.56')
    })
  })
})

describe('formatLocalizedNumber — bigint path', () => {
  describe('basic formatting', () => {
    it('integer bigint with decimals=0', () => {
      expect(formatLocalizedNumber(1234n, {locale: EN_US, decimals: 0})).toBe('1,234')
    })

    it('lovelace → ADA (decimals=6) integer', () => {
      expect(formatLocalizedNumber(1_234_000_000n, {locale: EN_US, decimals: 6})).toBe('1,234')
    })

    it('lovelace → ADA fractional', () => {
      expect(formatLocalizedNumber(1_500_000n, {locale: EN_US, decimals: 6})).toBe('1.5')
    })

    it('lovelace → ADA with minFrac padding', () => {
      expect(formatLocalizedNumber(1_500_000n, {locale: EN_US, decimals: 6, minFrac: 4})).toBe('1.5000')
    })

    it('caps fractional digits at maxFrac', () => {
      expect(formatLocalizedNumber(1_234_567n, {locale: EN_US, decimals: 6, maxFrac: 2})).toBe('1.23')
    })
  })

  describe('zero', () => {
    it('renders 0n with no minFrac', () => {
      expect(formatLocalizedNumber(0n, {locale: EN_US, decimals: 6})).toBe('0')
    })

    it('renders 0n with minFrac', () => {
      expect(formatLocalizedNumber(0n, {locale: EN_US, decimals: 6, minFrac: 2})).toBe('0.00')
    })
  })

  describe('negative bigint', () => {
    it('formats negative integer bigint', () => {
      expect(formatLocalizedNumber(-1_234_000_000n, {locale: EN_US, decimals: 6})).toBe('-1,234')
    })

    it('formats negative fractional bigint', () => {
      expect(formatLocalizedNumber(-1_500_000n, {locale: EN_US, decimals: 6, minFrac: 1, maxFrac: 1})).toBe('-1.5')
    })
  })

  describe('bigint precision past 2^53', () => {
    it('formats a 10^17 lovelace value without precision loss', () => {
      // 100_000_000_000_000_000n lovelace = 100,000,000,000 ADA — well past 2^53.
      // Going through `Number(lovelace) / 1e6` would lose precision; the bigint
      // overload preserves every digit.
      expect(formatLocalizedNumber(100_000_000_000_000_000n, {locale: EN_US, decimals: 6})).toBe('100,000,000,000')
    })

    it('formats 18-decimal ETH values without precision loss', () => {
      // 1234.56789 ETH as wei
      const wei = 1_234_567_890_000_000_000_000n
      expect(formatLocalizedNumber(wei, {locale: EN_US, decimals: 18})).toBe('1,234.56789')
    })

    it('preserves exact value at MAX_SAFE_INTEGER + 1', () => {
      const value = BigInt(Number.MAX_SAFE_INTEGER) + 1n
      // Integer formatting — no precision loss at this magnitude.
      expect(formatLocalizedNumber(value, {locale: EN_US, decimals: 0})).toBe('9,007,199,254,740,992')
    })
  })

  describe('half-up rounding (lossless bigint)', () => {
    it('1.95 ADA with maxFrac=1 rounds to "2.0"', () => {
      expect(formatLocalizedNumber(1_950_000n, {locale: EN_US, decimals: 6, minFrac: 1, maxFrac: 1})).toBe('2.0')
    })

    it('9.95 ADA carries through integer boundary to "10.0"', () => {
      expect(formatLocalizedNumber(9_950_000n, {locale: EN_US, decimals: 6, minFrac: 1, maxFrac: 1})).toBe('10.0')
    })

    it('1.94 ADA with maxFrac=1 rounds down to "1.9"', () => {
      expect(formatLocalizedNumber(1_940_000n, {locale: EN_US, decimals: 6, minFrac: 1, maxFrac: 1})).toBe('1.9')
    })

    it('rounds to integer when maxFrac=0', () => {
      expect(formatLocalizedNumber(1_500_000n, {locale: EN_US, decimals: 6, maxFrac: 0})).toBe('2')
    })
  })

  describe('truncation (rounding: "truncate")', () => {
    // 0.027369 ADA must render as 0.02 — never 0.03 — so the wallet does not
    // overstate accrued rewards / balances at narrow display precision.
    it('0.027369 ADA with maxFrac=2 truncates to "0.02"', () => {
      expect(
        formatLocalizedNumber(27_369n, {
          locale: EN_US,
          decimals: 6,
          minFrac: 1,
          maxFrac: 2,
          rounding: 'truncate',
        }),
      ).toBe('0.02')
    })

    it('1.95 ADA with maxFrac=1 truncates to "1.9" (no half-up)', () => {
      expect(
        formatLocalizedNumber(1_950_000n, {locale: EN_US, decimals: 6, minFrac: 1, maxFrac: 1, rounding: 'truncate'}),
      ).toBe('1.9')
    })

    it('9.99 ADA with maxFrac=1 truncates to "9.9" (no integer carry)', () => {
      expect(
        formatLocalizedNumber(9_990_000n, {locale: EN_US, decimals: 6, minFrac: 1, maxFrac: 1, rounding: 'truncate'}),
      ).toBe('9.9')
    })

    it('maxFrac=0 truncates fractional part entirely', () => {
      expect(formatLocalizedNumber(1_999_999n, {locale: EN_US, decimals: 6, maxFrac: 0, rounding: 'truncate'})).toBe(
        '1',
      )
    })

    // Number-input path: 0.29 cannot be represented exactly in IEEE 754
    // (stored as 0.28999…998). A naive `Number.toFixed(N)` with N > ~15
    // surfaces those trailing digits and a downstream truncation drops them
    // to "0.28". The truncate path must route through BigNumber's
    // shortest-decimal parse so 0.29 stays 0.29.
    it('number input 0.29 with maxFrac=2 truncates to "0.29" (not "0.28")', () => {
      expect(formatLocalizedNumber(0.29, {locale: EN_US, maxFrac: 2, rounding: 'truncate'})).toBe('0.29')
    })

    it('number input -0.29 with maxFrac=2 truncates to "-0.29"', () => {
      expect(formatLocalizedNumber(-0.29, {locale: EN_US, maxFrac: 2, rounding: 'truncate'})).toBe('-0.29')
    })

    it('number input 0.297 with maxFrac=2 truncates toward zero to "0.29"', () => {
      expect(formatLocalizedNumber(0.297, {locale: EN_US, maxFrac: 2, rounding: 'truncate'})).toBe('0.29')
    })

    it('number input 0.027369 with maxFrac=2 truncates to "0.02"', () => {
      expect(formatLocalizedNumber(0.027369, {locale: EN_US, minFrac: 1, maxFrac: 2, rounding: 'truncate'})).toBe(
        '0.02',
      )
    })
  })

  describe('locale separators', () => {
    it('de-DE on bigint', () => {
      expect(formatLocalizedNumber(1_234_560_000n, {locale: DE_DE, decimals: 6, minFrac: 2, maxFrac: 2})).toBe(
        '1.234,56',
      )
    })

    it('es-ES skips grouping below 10k on bigint', () => {
      expect(formatLocalizedNumber(1_234_560_000n, {locale: ES_ES, decimals: 6, minFrac: 2, maxFrac: 2})).toBe(
        '1234,56',
      )
    })

    it('es-ES groups at/above 10k on bigint', () => {
      expect(formatLocalizedNumber(12_345_670_000n, {locale: ES_ES, decimals: 6, minFrac: 2, maxFrac: 2})).toBe(
        '12.345,67',
      )
    })
  })

  describe('decimals defaults to 0', () => {
    it('omitting decimals treats bigint as integer', () => {
      expect(formatLocalizedNumber(1_234_567n, {locale: EN_US})).toBe('1,234,567')
    })
  })
})

describe('formatLocalizedNumber ↔ formatCrypto parity (plain path)', () => {
  // For the same value, decimals, and frac settings, the body of formatCrypto
  // (without symbol/abbreviate/subscript) must equal formatLocalizedNumber's
  // bigint output, since they share the formatPlain core.
  const cases: Array<{value: bigint; decimals: number; minFrac?: number; maxFrac?: number; locale: NumberLocale}> = [
    {value: 1_234_000_000n, decimals: 6, locale: EN_US},
    {value: 1_500_000n, decimals: 6, locale: EN_US},
    {value: -1_500_000n, decimals: 6, locale: EN_US},
    {value: 0n, decimals: 6, locale: EN_US, minFrac: 2},
    {value: 1_950_000n, decimals: 6, locale: EN_US, minFrac: 1, maxFrac: 1},
    {value: 9_950_000n, decimals: 6, locale: EN_US, minFrac: 1, maxFrac: 1},
    {value: 1_234_567_890_000_000_000_000n, decimals: 18, locale: EN_US},
    {value: 1_234_560_000n, decimals: 6, locale: DE_DE, minFrac: 2, maxFrac: 2},
    {value: 1_234_560_000n, decimals: 6, locale: ES_ES, minFrac: 2, maxFrac: 2},
    {value: 12_345_670_000n, decimals: 6, locale: ES_ES, minFrac: 2, maxFrac: 2},
    {value: 1_500_000n, decimals: 6, locale: EN_US, minFrac: 4},
    {value: 1_500_000n, decimals: 6, locale: EN_US, minFrac: 2, maxFrac: 8},
  ]

  for (const {value, decimals, minFrac, maxFrac, locale} of cases) {
    it(`${value}n at decimals=${decimals} locale=${locale.tag} min=${minFrac ?? 'd'} max=${maxFrac ?? 'd'}`, () => {
      const cryptoOut = formatCrypto(value, {
        decimals,
        locale,
        ...(minFrac != null ? {minFractionDigits: minFrac} : {}),
        ...(maxFrac != null ? {maxFractionDigits: maxFrac} : {}),
      })
      const localizedOut = formatLocalizedNumber(value, {
        locale,
        decimals,
        ...(minFrac != null ? {minFrac} : {}),
        ...(maxFrac != null ? {maxFrac} : {}),
      })
      expect(cryptoOut).toBe(localizedOut)
    })
  }
})

describe('formatCrypto — rounding option', () => {
  // End-to-end coverage of the path the staking earnings card uses:
  // bigint lovelace → subscript-eligible threshold check → plain formatter
  // with rounding=truncate. Guards against regressions where 0.027369 ADA
  // surfaces as 0.03 instead of 0.02 in the "Earnings" header.
  it('truncates 0.027369 ADA at maxFrac=2 to "0.02" (with subscript opt-in)', () => {
    expect(
      formatCrypto(27_369n, {
        decimals: 6,
        locale: EN_US,
        minFractionDigits: 1,
        maxFractionDigits: 2,
        subscript: true,
        rounding: 'truncate',
      }),
    ).toBe('0.02')
  })

  it('default rounding remains half-up (backwards compatible)', () => {
    expect(
      formatCrypto(27_369n, {
        decimals: 6,
        locale: EN_US,
        minFractionDigits: 1,
        maxFractionDigits: 2,
      }),
    ).toBe('0.03')
  })

  it('truncate respects minFractionDigits padding', () => {
    expect(
      formatCrypto(20_000n, {
        decimals: 6,
        locale: EN_US,
        minFractionDigits: 2,
        maxFractionDigits: 2,
        rounding: 'truncate',
      }),
    ).toBe('0.02')
  })
})

describe('formatLocalizedNumber number ↔ bigint parity (in-range values)', () => {
  // For values within Number precision, passing as `number` or as `(bigint,
  // decimals)` should produce the same output. Catches a regression where
  // the two paths diverge on rounding or locale grouping.
  const cases: Array<{
    asNumber: number
    asBigint: bigint
    decimals: number
    locale: NumberLocale
    minFrac?: number
    maxFrac?: number
  }> = [
    {asNumber: 1234.56, asBigint: 1_234_560_000n, decimals: 6, locale: EN_US, minFrac: 2, maxFrac: 2},
    {asNumber: 1.5, asBigint: 1_500_000n, decimals: 6, locale: EN_US, minFrac: 1, maxFrac: 1},
    {asNumber: 0, asBigint: 0n, decimals: 6, locale: EN_US, minFrac: 2, maxFrac: 2},
    {asNumber: -1234.56, asBigint: -1_234_560_000n, decimals: 6, locale: EN_US, minFrac: 2, maxFrac: 2},
    {asNumber: 12345.67, asBigint: 12_345_670_000n, decimals: 6, locale: ES_ES, minFrac: 2, maxFrac: 2},
  ]

  for (const {asNumber, asBigint, decimals, locale, minFrac, maxFrac} of cases) {
    it(`${asNumber} (number) === ${asBigint}n@${decimals} (bigint) for ${locale.tag}`, () => {
      const fromNumber = formatLocalizedNumber(asNumber, {
        locale,
        ...(minFrac != null ? {minFrac} : {}),
        ...(maxFrac != null ? {maxFrac} : {}),
      })
      const fromBigint = formatLocalizedNumber(asBigint, {
        locale,
        decimals,
        ...(minFrac != null ? {minFrac} : {}),
        ...(maxFrac != null ? {maxFrac} : {}),
      })
      expect(fromNumber).toBe(fromBigint)
    })
  }
})

describe('formatCrypto — TxReview lossless display regressions', () => {
  // Values pulled from a real Cardano "Review claim" surface where the
  // legacy `bigintToHumanNumber` path rendered as `1.9308800000000002 ADA`
  // and `1.6636600000000001 ADA`. The bigint primitive must keep them clean.
  it('1_930_880 lovelace → "1.93088 ADA"', () => {
    expect(formatCrypto(1_930_880n, {decimals: 6, locale: EN_US, symbol: 'ADA'})).toBe('1.93088 ADA')
  })

  it('1_663_660 lovelace → "1.66366 ADA"', () => {
    expect(formatCrypto(1_663_660n, {decimals: 6, locale: EN_US, symbol: 'ADA'})).toBe('1.66366 ADA')
  })

  it('659_912_616 base units NIGHT → "659.912616 NIGHT" (6 decimals)', () => {
    expect(formatCrypto(659_912_616n, {decimals: 6, locale: EN_US, symbol: 'NIGHT'})).toBe('659.912616 NIGHT')
  })

  it('1_561_651_560_218 base units NIGHT → "1,561,651.560218 NIGHT"', () => {
    expect(formatCrypto(1_561_651_560_218n, {decimals: 6, locale: EN_US, symbol: 'NIGHT'})).toBe(
      '1,561,651.560218 NIGHT',
    )
  })
})

describe('formatFiat — per-currency fractional-digit defaults', () => {
  it('USD with min/max omitted renders 2 decimals (Intl default)', () => {
    expect(formatFiat(10, {currency: 'USD', locale: EN_US})).toBe('$10.00')
  })

  it('JPY with min/max omitted renders 0 decimals (Intl default for zero-decimal currencies)', () => {
    expect(formatFiat(10, {currency: 'JPY', locale: EN_US})).toBe('¥10')
  })

  it('JPY with explicit min/max=2 still forces 2 decimals — regression guard for hardcoded 2,2', () => {
    expect(formatFiat(10, {currency: 'JPY', locale: EN_US, minFractionDigits: 2, maxFractionDigits: 2})).toBe('¥10.00')
  })
})
