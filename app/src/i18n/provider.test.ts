import {readFileSync} from 'node:fs'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {
  createRelativeTimeFormatter,
  createTranslator,
  interpolate,
  messageFormatCache,
  SUPPORTED_LOCALES,
} from './provider'

const {warnMock} = vi.hoisted(() => ({warnMock: vi.fn()}))
vi.mock('@pnyx/logger', () => ({getLogger: () => ({warn: warnMock})}))

describe('interpolate', () => {
  beforeEach(() => {
    messageFormatCache.clear()
    warnMock.mockClear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns the template unchanged when values is undefined', () => {
    expect(interpolate('No values here', undefined, 'en-US')).toBe('No values here')
  })

  it('substitutes a plain {var} placeholder (backward compat)', () => {
    expect(interpolate('Hello {name}', {name: 'World'}, 'en-US')).toBe('Hello World')
  })

  it('selects the ICU plural `one` branch for count=1 under en-US', () => {
    expect(interpolate('{count, plural, one {# item} other {# items}}', {count: 1}, 'en-US')).toBe('1 item')
  })

  it('selects the ICU plural `other` branch for count=5 under en-US', () => {
    expect(interpolate('{count, plural, one {# item} other {# items}}', {count: 5}, 'en-US')).toBe('5 items')
  })

  it('selects the ICU `=0` exact-match branch when count is zero', () => {
    expect(interpolate('{count, plural, =0 {No tabs} one {# Tab} other {# Tabs}}', {count: 0}, 'en-US')).toBe('No tabs')
  })

  it('drives CLDR plural categories per locale (ru-RU one/few/many)', () => {
    const template = '{count, plural, one {# элемент} few {# элемента} many {# элементов} other {# элемента}}'
    expect(interpolate(template, {count: 1}, 'ru-RU')).toBe('1 элемент')
    expect(interpolate(template, {count: 3}, 'ru-RU')).toBe('3 элемента')
    expect(interpolate(template, {count: 5}, 'ru-RU')).toBe('5 элементов')
  })

  it('reuses cached IntlMessageFormat instances for repeated (locale, template) keys', () => {
    const template = '{count, plural, one {# item} other {# items}}'
    interpolate(template, {count: 1}, 'en-US')
    interpolate(template, {count: 7}, 'en-US')
    interpolate(template, {count: 7}, 'en-US')
    expect(messageFormatCache.size).toBe(1)
  })

  it('keys the cache by (locale, template) — different locales produce separate entries', () => {
    const template = '{count, plural, one {# x} other {# y}}'
    interpolate(template, {count: 1}, 'en-US')
    interpolate(template, {count: 1}, 'ru-RU')
    expect(messageFormatCache.size).toBe(2)
  })

  it('falls back to the unparsed template and warns via logger when a required value is missing', () => {
    const template = '{count, plural, one {# item} other {# items}}'
    expect(interpolate(template, {wrongKey: 1}, 'en-US')).toBe(template)
    expect(warnMock).toHaveBeenCalledOnce()
  })

  // Regression for the literal-`{count, plural, …}` bug: Hermes has no
  // Intl.PluralRules, so intl-messageformat throws on every plural and the raw
  // template leaks to the UI. The fix loads @formatjs/intl-pluralrules in
  // index.js; this asserts the failure mode the polyfill prevents.
  it('falls back to the raw template when Intl.PluralRules is unavailable', () => {
    const original = Intl.PluralRules
    ;(Intl as {PluralRules?: unknown}).PluralRules = undefined
    messageFormatCache.clear()
    try {
      const template = '{count, plural, one {# word} other {# words}}'
      expect(interpolate(template, {count: 1}, 'en-US')).toBe(template)
      expect(warnMock).toHaveBeenCalledOnce()
    } finally {
      ;(Intl as {PluralRules?: unknown}).PluralRules = original
      messageFormatCache.clear()
    }
  })
})

describe('createTranslator', () => {
  beforeEach(() => {
    messageFormatCache.clear()
  })

  it('returns a plain EN string for a no-values key', () => {
    const t = createTranslator('en-US')
    expect(t('common.buttons.cancel')).toBe('Cancel')
  })

  it('drives ICU plural selection through the t() path (one branch)', () => {
    const t = createTranslator('en-US')
    expect(t('onboarding.recovery.wordCount', {count: 1})).toBe('1 word')
  })

  it('drives ICU plural selection through the t() path (other branch)', () => {
    const t = createTranslator('en-US')
    expect(t('onboarding.recovery.wordCount', {count: 5})).toBe('5 words')
  })
})

describe('createRelativeTimeFormatter', () => {
  it('formats a future offset under en-US', () => {
    expect(createRelativeTimeFormatter('en-US')(12, 'hour')).toBe('in 12 hours')
  })

  it('formats a past offset under en-US', () => {
    expect(createRelativeTimeFormatter('en-US')(-2, 'day')).toBe('2 days ago')
  })

  // Hermes exposes only Collator / DateTimeFormat / NumberFormat /
  // getCanonicalLocales, so the constructor itself is missing on device — this
  // throws rather than degrading, which crashed the Connected dApps screen for
  // any grant carrying an expiry. index.js loads
  // @formatjs/intl-relativetimeformat to supply it; this pins the failure mode
  // that polyfill prevents, so deleting it from index.js cannot go unnoticed.
  it('throws when Intl.RelativeTimeFormat is unavailable, as on unpolyfilled Hermes', () => {
    const original = Intl.RelativeTimeFormat
    ;(Intl as {RelativeTimeFormat?: unknown}).RelativeTimeFormat = undefined
    try {
      expect(() => createRelativeTimeFormatter('en-US')(12, 'hour')).toThrow()
    } finally {
      ;(Intl as {RelativeTimeFormat?: unknown}).RelativeTimeFormat = original
    }
  })
})

// The polyfill only helps for locales whose CLDR data is bundled, and those
// requires must be static literals, so a newly supported locale is easy to miss.
describe('index.js Intl locale data', () => {
  const entry = readFileSync(new URL('../../index.js', import.meta.url), 'utf8')

  // Relative-time wording differs between Simplified and Traditional, so zh-TW
  // needs zh-Hant. Plural rules don't: Chinese has one category and the package
  // ships only `zh`.
  const packages = [
    {name: 'intl-pluralrules', hantAware: false},
    {name: 'intl-relativetimeformat', hantAware: true},
  ] as const

  for (const {name, hantAware} of packages) {
    it.each(Object.keys(SUPPORTED_LOCALES))(`loads @formatjs/${name} data covering %s`, (locale) => {
      const tag = hantAware && locale === 'zh-TW' ? 'zh-Hant' : (locale.split('-')[0] as string)
      expect(entry).toContain(`@formatjs/${name}/locale-data/${tag}.js`)
    })
  }
})
