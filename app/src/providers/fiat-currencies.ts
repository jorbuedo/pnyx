/**
 * Single source of truth for the wallet's fiat currency set. The type union,
 * code list, and symbol map all derive from this array — adding a currency
 * is a single edit.
 */

export const FIAT_CURRENCIES = [
  {code: 'USD', label: 'US Dollar', symbol: '$'},
  {code: 'EUR', label: 'Euro', symbol: '€'},
  {code: 'GBP', label: 'British Pound', symbol: '£'},
  {code: 'JPY', label: 'Japanese Yen', symbol: '¥'},
  {code: 'CAD', label: 'Canadian Dollar', symbol: 'C$'},
  {code: 'AUD', label: 'Australian Dollar', symbol: 'A$'},
  {code: 'CHF', label: 'Swiss Franc', symbol: 'Fr'},
  {code: 'CNY', label: 'Chinese Yuan', symbol: '¥'},
  {code: 'KRW', label: 'South Korean Won', symbol: '₩'},
  {code: 'BRL', label: 'Brazilian Real', symbol: 'R$'},
  {code: 'INR', label: 'Indian Rupee', symbol: '₹'},
  {code: 'MXN', label: 'Mexican Peso', symbol: '$'},
  {code: 'SGD', label: 'Singapore Dollar', symbol: 'S$'},
  {code: 'SEK', label: 'Swedish Krona', symbol: 'kr'},
  {code: 'NOK', label: 'Norwegian Krone', symbol: 'kr'},
] as const satisfies readonly {readonly code: string; readonly label: string; readonly symbol: string}[]

export type FiatCurrency = (typeof FIAT_CURRENCIES)[number]['code']

export const FIAT_CURRENCY_CODES: readonly FiatCurrency[] = FIAT_CURRENCIES.map((c) => c.code)

export const FIAT_SYMBOLS = Object.fromEntries(FIAT_CURRENCIES.map((c) => [c.code, c.symbol])) as Record<
  FiatCurrency,
  string
>

export type FiatCurrencyEntry = (typeof FIAT_CURRENCIES)[number]

export const FIAT_CURRENCY_BY_CODE = Object.fromEntries(FIAT_CURRENCIES.map((c) => [c.code, c])) as Record<
  FiatCurrency,
  FiatCurrencyEntry
>
