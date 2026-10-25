/**
 * Checks a translated locale against the English source before it is emitted.
 *
 *   bun scripts/i18n/validate.ts <locale> [workDir]
 *
 * Exits non-zero on any issue and writes the full list to
 * `<workDir>/out/<locale>/ISSUES.json`. Nothing reaches `src/i18n/` until this
 * passes: `interpolate` degrades malformed ICU to raw template text on screen,
 * so a bad plural would ship as visible `{count, plural, ...}` gibberish.
 */
import {parse, TYPE} from '@formatjs/icu-messageformat-parser'
import IntlMessageFormat from 'intl-messageformat'
import {pluralCategories} from './locales'

const locale = process.argv[2]
const WORK = process.argv[3] ?? `${import.meta.dir}/../../.i18n-work`
if (!locale) throw new Error('usage: bun scripts/i18n/validate.ts <locale> [workDir]')

const categories = pluralCategories(locale)

/**
 * Pure UI glyphs, not prose. They must be byte-identical to English so the
 * "no value" dash looks the same in every locale. The no-em-dash copy rule
 * does not reach them.
 */
const VERBATIM_KEYS = new Set(['you.handle.screen.tierUnknown'])

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

const issues: {chunk: string; key: string; why: string}[] = []
let checked = 0
const files = [...new Bun.Glob('chunk-*.json').scanSync(`${WORK}/src`)].sort()

for (const file of files) {
  const en: Record<string, string> = await Bun.file(`${WORK}/src/${file}`).json()
  const path = `${WORK}/out/${locale}/${file}`
  if (!(await Bun.file(path).exists())) {
    issues.push({chunk: file, key: '*', why: 'chunk missing'})
    continue
  }

  let translated: Record<string, string>
  try {
    translated = await Bun.file(path).json()
  } catch (error) {
    issues.push({chunk: file, key: '*', why: `unparseable JSON: ${String(error)}`})
    continue
  }

  for (const key of Object.keys(en)) if (!(key in translated)) issues.push({chunk: file, key, why: 'key missing'})
  for (const key of Object.keys(translated)) if (!(key in en)) issues.push({chunk: file, key, why: 'key not in source'})

  for (const [key, source] of Object.entries(en)) {
    const value = translated[key]
    if (typeof value !== 'string') {
      if (key in translated) issues.push({chunk: file, key, why: 'not a string'})
      continue
    }
    checked++
    // A whitespace-only translation is legitimate for a short connector fragment
    // (English " to " joining two bolded spans needs no equivalent in CJK), but
    // never for real copy.
    if (value.trim() === '' && source.trim().length > 6) {
      issues.push({chunk: file, key, why: `empty (English: ${JSON.stringify(source)})`})
      continue
    }
    if (value === '' && source !== '') {
      issues.push({chunk: file, key, why: `empty (English: ${JSON.stringify(source)})`})
      continue
    }
    if (value.includes('—') && !source.includes('—')) issues.push({chunk: file, key, why: 'em dash introduced'})
    if (VERBATIM_KEYS.has(key) && value !== source) {
      issues.push({
        chunk: file,
        key,
        why: `glyph key must copy English verbatim: ${JSON.stringify(source)} got ${JSON.stringify(value)}`,
      })
    }

    let want: Shape
    let got: Shape
    try {
      want = shape(source)
    } catch (error) {
      issues.push({chunk: file, key, why: `EN unparseable: ${String(error)}`})
      continue
    }
    try {
      got = shape(value)
    } catch (error) {
      issues.push({chunk: file, key, why: `ICU parse failed: ${String(error).slice(0, 120)}`})
      continue
    }

    if (want.args.join('|') !== got.args.join('|')) {
      issues.push({chunk: file, key, why: `placeholders ${JSON.stringify(want.args)} -> ${JSON.stringify(got.args)}`})
    }
    if (want.tags.join('|') !== got.tags.join('|')) {
      issues.push({chunk: file, key, why: `rich-text tags ${JSON.stringify(want.tags)} -> ${JSON.stringify(got.tags)}`})
    }
    if (want.plurals.length !== got.plurals.length) {
      issues.push({chunk: file, key, why: `plural blocks ${want.plurals.length} -> ${got.plurals.length}`})
    } else {
      for (const branches of got.plurals) {
        const missing = categories.filter((c) => !branches.includes(c) && !branches.includes(`=${c}`))
        if (missing.length > 0) {
          issues.push({chunk: file, key, why: `plural missing ${missing.join(',')} (has ${branches.join(',')})`})
        }
      }
    }

    try {
      const values: Record<string, unknown> = Object.fromEntries(
        got.args.map((n) => [n, /count|num|total|blocks|kb/i.test(n) ? 2 : 'x']),
      )
      for (const tag of got.tags) values[tag] = (parts: unknown) => parts
      new IntlMessageFormat(value, locale).format(values)
    } catch (error) {
      issues.push({chunk: file, key, why: `format failed: ${String(error).slice(0, 120)}`})
    }
  }
}

console.log(`${locale}: ${checked} strings checked across ${files.length} chunks, ${issues.length} issues`)
const counts = new Map<string, number>()
for (const issue of issues) {
  const bucket = issue.why.replace(/\d+/g, 'N').slice(0, 60)
  counts.set(bucket, (counts.get(bucket) ?? 0) + 1)
}
for (const [why, n] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${why}`)

if (issues.length > 0) {
  await Bun.write(`${WORK}/out/${locale}/ISSUES.json`, JSON.stringify(issues, null, 1))
  console.log('\nfirst 15:')
  for (const issue of issues.slice(0, 15)) console.log(`  ${issue.chunk} ${issue.key}: ${issue.why}`)
  process.exit(1)
}
