/**
 * Resolves the device's preferred fiat currency from `expo-localization`,
 * constrained to the wallet's supported set.
 *
 * Used on first install (before the user has explicitly chosen a currency in
 * settings) so that, e.g., a Brazilian-region device starts in BRL rather than
 * the hardcoded USD default.
 *
 * Resolution order:
 *   1. `Locale.currencyCode` from the OS (e.g. iOS Region setting). Null on Web.
 *   2. `Locale.regionCode` mapped via `REGION_TO_CURRENCY`. The map only covers
 *      regions for which we ship a translation AND a matching display currency,
 *      so the device default only biases users we explicitly serve.
 *   3. `'USD'` fallback.
 */

import {getLocales} from 'expo-localization'
import {FIAT_CURRENCY_CODES, type FiatCurrency} from './fiat-currencies'

const FALLBACK_CURRENCY: FiatCurrency = 'USD'

// Keyed by the region of each SUPPORTED_LOCALES entry (see i18n/provider.ts).
// Entries are included only when the region's currency is also in FIAT_CURRENCIES.
// id-ID, ru-RU, vi-VN, zh-TW have translations but their primary currencies
// (IDR, RUB, VND, TWD) are not supported — those users fall back to USD.
const REGION_TO_CURRENCY: Readonly<Record<string, FiatCurrency>> = {
  US: 'USD', // en-US
  DE: 'EUR', // de-DE
  ES: 'EUR', // es-ES
  FR: 'EUR', // fr-FR
  JP: 'JPY', // ja-JP
  KR: 'KRW', // ko-KR
  BR: 'BRL', // pt-BR
  CN: 'CNY', // zh-CN
}

const SUPPORTED_CODES = FIAT_CURRENCY_CODES as readonly string[]

function isSupported(code: string | null | undefined): code is FiatCurrency {
  return typeof code === 'string' && SUPPORTED_CODES.includes(code)
}

export function resolveDeviceCurrency(): FiatCurrency {
  const locale = getLocales()[0]

  if (isSupported(locale?.currencyCode)) return locale.currencyCode as FiatCurrency

  const region = locale?.regionCode
  const mapped = region ? REGION_TO_CURRENCY[region] : undefined
  if (mapped) return mapped

  return FALLBACK_CURRENCY
}
