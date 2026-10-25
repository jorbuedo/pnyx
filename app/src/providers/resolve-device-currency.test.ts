import {beforeEach, describe, expect, it, vi} from 'vitest'

const getLocalesMock = vi.fn()

vi.mock('expo-localization', () => ({
  getLocales: () => getLocalesMock(),
}))

import {resolveDeviceCurrency} from './resolve-device-currency'

function setLocale(opts: {currencyCode?: string | null; regionCode?: string | null; languageTag?: string}) {
  getLocalesMock.mockReturnValue([
    {
      languageTag: opts.languageTag ?? 'en-US',
      currencyCode: opts.currencyCode ?? null,
      regionCode: opts.regionCode ?? null,
    },
  ])
}

describe('resolveDeviceCurrency', () => {
  beforeEach(() => {
    getLocalesMock.mockReset()
  })

  it('uses the device currencyCode when supported (Brazil → BRL)', () => {
    setLocale({currencyCode: 'BRL', regionCode: 'BR', languageTag: 'pt-BR'})
    expect(resolveDeviceCurrency()).toBe('BRL')
  })

  it('uses the device currencyCode when supported (Japan → JPY)', () => {
    setLocale({currencyCode: 'JPY', regionCode: 'JP', languageTag: 'ja-JP'})
    expect(resolveDeviceCurrency()).toBe('JPY')
  })

  it('falls back to region map when currencyCode is null (web pt-BR → BRL)', () => {
    setLocale({currencyCode: null, regionCode: 'BR', languageTag: 'pt-BR'})
    expect(resolveDeviceCurrency()).toBe('BRL')
  })

  it('maps DE region to EUR (de-DE is a supported translation)', () => {
    setLocale({currencyCode: null, regionCode: 'DE', languageTag: 'de-DE'})
    expect(resolveDeviceCurrency()).toBe('EUR')
  })

  it('maps FR region to EUR (fr-FR is a supported translation)', () => {
    setLocale({currencyCode: null, regionCode: 'FR', languageTag: 'fr-FR'})
    expect(resolveDeviceCurrency()).toBe('EUR')
  })

  it('does NOT map Eurozone regions without a supported translation (IT → USD)', () => {
    setLocale({currencyCode: null, regionCode: 'IT', languageTag: 'it-IT'})
    expect(resolveDeviceCurrency()).toBe('USD')
  })

  it('honors OS currencyCode even when the region has no map entry (IT with EUR → EUR)', () => {
    setLocale({currencyCode: 'EUR', regionCode: 'IT', languageTag: 'it-IT'})
    expect(resolveDeviceCurrency()).toBe('EUR')
  })

  it('falls back to USD when a supported-translation region has no supported currency (id-ID → USD)', () => {
    setLocale({currencyCode: 'IDR', regionCode: 'ID', languageTag: 'id-ID'})
    expect(resolveDeviceCurrency()).toBe('USD')
  })

  it('falls back to USD when the OS currency is unsupported and region is unknown', () => {
    setLocale({currencyCode: 'JOD', regionCode: 'JO', languageTag: 'ar-JO'})
    expect(resolveDeviceCurrency()).toBe('USD')
  })

  it('falls back to USD when getLocales() returns an empty array', () => {
    getLocalesMock.mockReturnValue([])
    expect(resolveDeviceCurrency()).toBe('USD')
  })

  it('falls back to USD when both currencyCode and regionCode are null', () => {
    setLocale({currencyCode: null, regionCode: null})
    expect(resolveDeviceCurrency()).toBe('USD')
  })
})
