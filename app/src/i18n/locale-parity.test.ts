import {parse, TYPE} from '@formatjs/icu-messageformat-parser'
import {describe, expect, it} from 'vitest'
import {type LocaleCode, SUPPORTED_LOCALES} from './provider'

/**
 * Every locale must carry exactly the English key set, the same placeholders,
 * and plural blocks covering its own CLDR categories. `createTranslator` falls
 * back to English per key, so a missing key is invisible at runtime: without
 * these checks a locale silently rots back into English. A malformed ICU
 * template is worse than invisible, because `interpolate` degrades it to the
 * raw template text on screen rather than throwing.
 */

const EN = SUPPORTED_LOCALES['en-US'].messages
const LOCALES = (Object.keys(SUPPORTED_LOCALES) as LocaleCode[]).filter((l) => l !== 'en-US')

type Shape = {args: string[]; plurals: string[][]; tags: string[]}

function shape(message: string): Shape {
  const args = new Set<string>()
  const plurals: string[][] = []
  const tags = new Set<string>()
  const walk = (elements: ReturnType<typeof parse>): void => {
    for (const el of elements) {
      if (el.type === TYPE.argument || el.type === TYPE.number || el.type === TYPE.date || el.type === TYPE.time) {
        args.add(el.value)
      } else if (el.type === TYPE.plural || el.type === TYPE.select) {
        args.add(el.value)
        if (el.type === TYPE.plural) plurals.push(Object.keys(el.options).sort())
        for (const option of Object.values(el.options)) walk(option.value)
      } else if (el.type === TYPE.tag) {
        tags.add(el.value)
        walk(el.children)
      }
    }
  }
  walk(parse(message))
  return {args: [...args].sort(), plurals, tags: [...tags].sort()}
}

describe.each(LOCALES)('%s', (locale) => {
  const messages = SUPPORTED_LOCALES[locale].messages
  const categories = new Intl.PluralRules(locale).resolvedOptions().pluralCategories

  /** Key/English/translation triples for keys this locale actually has. */
  const shared = Object.entries(EN).flatMap(([key, english]) => {
    const translated = messages[key]
    return translated === undefined ? [] : [{key, english, translated}]
  })

  it('carries exactly the English key set', () => {
    const missing = Object.keys(EN).filter((k) => !(k in messages))
    const extra = Object.keys(messages).filter((k) => !(k in EN))
    expect({missing, extra}).toEqual({missing: [], extra: []})
  })

  it('preserves every placeholder', () => {
    const drifted = shared
      .map(({key, english, translated}) => ({key, en: shape(english).args, got: shape(translated).args}))
      .filter(({en, got}) => en.join('|') !== got.join('|'))
    expect(drifted).toEqual([])
  })

  it('preserves every rich-text tag', () => {
    const drifted = shared
      .map(({key, english, translated}) => ({key, en: shape(english).tags, got: shape(translated).tags}))
      .filter(({en, got}) => en.join('|') !== got.join('|'))
    expect(drifted).toEqual([])
  })

  it('keeps every plural block English has', () => {
    const dropped = shared
      .map(({key, english, translated}) => ({
        key,
        en: shape(english).plurals.length,
        got: shape(translated).plurals.length,
      }))
      .filter(({en, got}) => en !== got)
    expect(dropped).toEqual([])
  })

  it('covers this locale’s plural categories', () => {
    const gaps = shared.flatMap(({key, translated}) =>
      shape(translated)
        .plurals.map((branches) => ({
          key,
          missing: categories.filter((c) => !branches.includes(c) && !branches.includes(`=${c}`)),
        }))
        .filter(({missing}) => missing.length > 0),
    )
    expect(gaps).toEqual([])
  })

  it('has no em dashes in its copy', () => {
    const offenders = shared
      .filter(({english, translated}) => translated.includes('—') && !english.includes('—'))
      .map(({key}) => key)
    expect(offenders).toEqual([])
  })
})
