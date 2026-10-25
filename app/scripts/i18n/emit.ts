/**
 * Rebuilds `src/i18n/translations_<locale>.ts` from validated chunks.
 *
 *   bun scripts/i18n/emit.ts <locale> [workDir]
 *
 * Key order and nesting follow the English source, so a locale file diffs
 * cleanly against `translations.ts`.
 */
import {translations as english} from '../../src/i18n/translations'
import {LOCALES} from './locales'

const locale = process.argv[2]
const WORK = process.argv[3] ?? `${import.meta.dir}/../../.i18n-work`
const OUT_DIR = `${import.meta.dir}/../../src/i18n`
if (!locale) throw new Error('usage: bun scripts/i18n/emit.ts <locale> [workDir]')

const spec = LOCALES.find((l) => l.code === locale)
if (!spec) throw new Error(`unknown locale ${locale}`)

const flat: Record<string, string> = {}
for (const file of [...new Bun.Glob('chunk-*.json').scanSync(`${WORK}/src`)].sort()) {
  const en: Record<string, string> = await Bun.file(`${WORK}/src/${file}`).json()
  const translated: Record<string, string> = await Bun.file(`${WORK}/out/${locale}/${file}`).json()
  for (const key of Object.keys(en)) {
    const value = translated[key]
    if (typeof value !== 'string') throw new Error(`${file}: no translation for ${key} (run validate.ts first)`)
    flat[key] = value
  }
}

/**
 * Mirror the English object's own shape rather than re-nesting on ".". Some
 * English keys contain a literal dot (`agents: {'activity.refused': ...}`),
 * which flattens to the same lookup key but is a different object. Walking the
 * source keeps every locale file diffable against `translations.ts` line for line.
 */
type Node = {[key: string]: Node | string}

function mirror(source: Record<string, unknown>, prefix = ''): Node {
  const out: Node = {}
  for (const [key, child] of Object.entries(source)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (typeof child === 'string') {
      const value = flat[path]
      if (typeof value !== 'string') throw new Error(`missing translation for ${path}`)
      out[key] = value
    } else if (child && typeof child === 'object') {
      out[key] = mirror(child as Record<string, unknown>, path)
    }
  }
  return out
}

const root = mirror(english as unknown as Record<string, unknown>)

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/**
 * `JSON.stringify` does the escaping (backslashes, quotes, and control
 * characters — at least one string carries embedded newlines), then the
 * double-quoted form is converted to the repo's single-quote style unless the
 * value itself contains an apostrophe.
 */
const literal = (value: string) => {
  const json = JSON.stringify(value)
  return value.includes("'") ? json : `'${json.slice(1, -1).replace(/\\"/g, '"')}'`
}

const render = (node: Node, indent: string): string =>
  Object.entries(node)
    .map(([key, value]) => {
      const name = IDENTIFIER.test(key) ? key : `'${key}'`
      return typeof value === 'string'
        ? `${indent}${name}: ${literal(value)},`
        : `${indent}${name}: {\n${render(value, `${indent}  `)}\n${indent}},`
    })
    .join('\n')

const body = `/**
 * ${spec.englishName} (${locale}) translations for the wallet app.
 * Translated from the English source in \`translations.ts\`, which is the only
 * file where a string is authored. Keys mirror it exactly.
 */
export const translations = {
${render(root, '  ')}
} as const

export default translations
`

await Bun.write(`${OUT_DIR}/translations_${locale}.ts`, body)
console.log(`wrote translations_${locale}.ts — ${Object.keys(flat).length} keys`)
