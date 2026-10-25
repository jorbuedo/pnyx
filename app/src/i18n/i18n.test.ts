import {describe, expect, it} from 'vitest'
import {
  createCurrencyFormatter,
  createDateFormatter,
  createNumberFormatter,
  createProvider,
  createRelativeTimeFormatter,
  createTranslator,
  interpolate,
} from './provider'

describe('interpolate', () => {
  it('should return template unchanged without values', () => {
    expect(interpolate('Hello, world!', undefined, 'en-US')).toBe('Hello, world!')
  })

  it('should interpolate single placeholder', () => {
    expect(interpolate('Hello, {name}!', {name: 'Alice'}, 'en-US')).toBe('Hello, Alice!')
  })

  it('should interpolate multiple placeholders', () => {
    expect(interpolate('{greeting}, {name}!', {greeting: 'Hello', name: 'Bob'}, 'en-US')).toBe('Hello, Bob!')
  })

  it('should handle repeated placeholders', () => {
    expect(interpolate('{name} met {name}', {name: 'Charlie'}, 'en-US')).toBe('Charlie met Charlie')
  })

  it('should leave unknown placeholders unchanged', () => {
    expect(interpolate('Hello, {name}!', {}, 'en-US')).toBe('Hello, {name}!')
  })

  it('should handle numeric values', () => {
    expect(interpolate('Count: {count}', {count: 42}, 'en-US')).toBe('Count: 42')
  })

  it('should handle boolean values', () => {
    expect(interpolate('Active: {active}', {active: true}, 'en-US')).toBe('Active: true')
  })
})

describe('createTranslator', () => {
  it('should translate keys', () => {
    const t = createTranslator('en-US')
    expect(t('common.buttons.cancel')).toBe('Cancel')
  })

  it('should translate nested keys', () => {
    const t = createTranslator('en-US')
    expect(t('dashboard.featureCards.staking.title')).toBe('Staking')
  })

  it('should interpolate values in translations', () => {
    const t = createTranslator('en-US')
    expect(t('receive.shareTitle', {chainName: 'Cardano'})).toBe('My Cardano Address')
  })

  it('should use the selected locale when it has the key', () => {
    const t = createTranslator('ja-JP')
    const result = t('common.buttons.cancel')
    // Japanese locale is loaded — result must not be the !!-prefixed sentinel
    expect(result).not.toBe('!!common.buttons.cancel')
    expect(result.length).toBeGreaterThan(0)
  })

  it('should fall back to English when locale is unknown', () => {
    // An unrecognised locale has no dict, so every key must come from English
    const t = createTranslator('xx-UNKNOWN')
    expect(t('common.buttons.cancel')).toBe('Cancel')
    expect(t('common.buttons.confirm')).toBe('Confirm')
  })

  it('should return !!key sentinel when translation not found in any locale', () => {
    const t = createTranslator('en-US')
    // @ts-expect-error - Testing invalid key
    expect(t('nonexistent.key')).toBe('!!nonexistent.key')
  })

  it('should return !!key sentinel for unknown locale and unknown key', () => {
    const t = createTranslator('xx-UNKNOWN')
    // @ts-expect-error - Testing invalid key
    expect(t('nonexistent.key')).toBe('!!nonexistent.key')
  })
})

describe('createNumberFormatter', () => {
  it('should format numbers with default options', () => {
    const formatNumber = createNumberFormatter('en-US')
    expect(formatNumber(1234.56)).toBe('1,234.56')
  })

  it('should format numbers with custom fraction digits', () => {
    const formatNumber = createNumberFormatter('en-US')
    expect(formatNumber(1234.5678, {minimumFractionDigits: 2, maximumFractionDigits: 2})).toBe('1,234.57')
  })

  it('should format numbers without grouping', () => {
    const formatNumber = createNumberFormatter('en-US')
    expect(formatNumber(1234567, {useGrouping: false})).toBe('1234567')
  })
})

describe('createDateFormatter', () => {
  it('should format dates with default options', () => {
    const formatDate = createDateFormatter('en-US')
    const date = new Date('2024-03-15T12:00:00Z')
    // Just check it returns a string (exact format depends on timezone)
    expect(typeof formatDate(date)).toBe('string')
    expect(formatDate(date).length).toBeGreaterThan(0)
  })

  it('should format dates with dateStyle', () => {
    const formatDate = createDateFormatter('en-US')
    const date = new Date('2024-03-15T12:00:00Z')
    const formatted = formatDate(date, {dateStyle: 'short'})
    expect(formatted).toMatch(/\d/)
  })
})

describe('createCurrencyFormatter', () => {
  it('should format currency with symbol', () => {
    const formatCurrency = createCurrencyFormatter('en-US')
    expect(formatCurrency(1234.56, {currency: 'USD'})).toBe('$1,234.56')
  })

  it('should format currency with code display', () => {
    const formatCurrency = createCurrencyFormatter('en-US')
    const formatted = formatCurrency(1234.56, {currency: 'USD', display: 'code'})
    expect(formatted).toContain('USD')
  })
})

describe('createRelativeTimeFormatter', () => {
  it('should format relative time in the past', () => {
    const formatRelativeTime = createRelativeTimeFormatter('en-US')
    expect(formatRelativeTime(-1, 'day')).toBe('yesterday')
  })

  it('should format relative time in the future', () => {
    const formatRelativeTime = createRelativeTimeFormatter('en-US')
    expect(formatRelativeTime(1, 'day')).toBe('tomorrow')
  })

  it('should handle plural units', () => {
    const formatRelativeTime = createRelativeTimeFormatter('en-US')
    expect(formatRelativeTime(-2, 'days')).toBe('2 days ago')
  })
})

describe('createProvider', () => {
  it('should create a complete provider', () => {
    const provider = createProvider('en-US')
    expect(typeof provider.t).toBe('function')
    expect(typeof provider.formatNumber).toBe('function')
    expect(typeof provider.formatDate).toBe('function')
    expect(typeof provider.formatCurrency).toBe('function')
    expect(typeof provider.formatRelativeTime).toBe('function')
  })

  it('should translate using the provider', () => {
    const provider = createProvider('en-US')
    expect(provider.t('common.buttons.confirm')).toBe('Confirm')
  })
})
