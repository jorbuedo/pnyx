/**
 * Per-locale translation settings. Everything here is handed to the translator
 * verbatim; `pluralCategories` is derived from CLDR at runtime so it cannot
 * drift from what `intl-messageformat` actually selects.
 */
export type LocaleSpec = {
  code: string
  englishName: string
  register: string
  /** What "wallet" is called in this locale's copy. Use it everywhere, compounds included. */
  walletTerm: string
  notes?: string
}

export const LOCALES: readonly LocaleSpec[] = [
  {
    code: 'de-DE',
    englishName: 'German',
    register: 'informal second person (du, dein). This matches the existing German copy.',
    walletTerm: 'Wallet, the established German fintech loanword. Never Geldbörse or Brieftasche.',
  },
  {
    code: 'es-ES',
    englishName: 'Spanish (Spain)',
    register: 'informal second person (tú, tu). This matches the existing Spanish copy.',
    walletTerm: 'cartera. Never the English "wallet".',
  },
  {
    code: 'fr-FR',
    englishName: 'French',
    register: 'formal second person (vous, votre). This matches the existing French copy.',
    walletTerm: 'portefeuille',
  },
  {
    code: 'id-ID',
    englishName: 'Indonesian',
    register: 'neutral polite (Anda).',
    walletTerm: 'dompet',
  },
  {
    code: 'ja-JP',
    englishName: 'Japanese',
    register: 'polite ですます調. Avoid 敬語 beyond that.',
    walletTerm: 'ウォレット',
  },
  {
    code: 'ko-KR',
    englishName: 'Korean',
    register: 'polite 해요체.',
    walletTerm: '지갑',
  },
  {
    code: 'pt-BR',
    englishName: 'Portuguese (Brazil)',
    register: 'second person via você.',
    walletTerm: 'carteira',
  },
  {
    code: 'ru-RU',
    englishName: 'Russian',
    register: 'polite вы, lowercase.',
    walletTerm: 'кошелёк',
  },
  {
    code: 'vi-VN',
    englishName: 'Vietnamese',
    register: 'neutral, address the reader as bạn.',
    walletTerm: 'ví',
  },
  {
    code: 'zh-CN',
    englishName: 'Chinese (Simplified)',
    register: 'neutral 你, or no pronoun where natural.',
    walletTerm: '钱包',
    notes: 'Use full-width punctuation (。，：（）) rather than ASCII punctuation.',
  },
  {
    code: 'zh-TW',
    englishName: 'Chinese (Traditional)',
    register: 'neutral 您, or no pronoun where natural.',
    walletTerm: '錢包',
    notes:
      'Use full-width punctuation (。，：（）) rather than ASCII punctuation. Use Taiwan terminology, not a Simplified-to-Traditional character swap.',
  },
]

export const pluralCategories = (locale: string): readonly Intl.LDMLPluralRule[] =>
  new Intl.PluralRules(locale).resolvedOptions().pluralCategories
