import {parse, TYPE} from '@formatjs/icu-messageformat-parser'
import {describe, expect, it} from 'vitest'
import {translations} from './translations'

/**
 * In ICU MessageFormat an ASCII apostrophe is an escape character, so
 * `No results found for '{query}'` renders the literal text `{query}` and the
 * placeholder silently never interpolates. Nothing throws and no test of the
 * key's presence catches it: the screen just shows braces to the user.
 *
 * A brace surviving into a parsed *literal* node is the exact signature of that
 * mistake. Use typographic quotes (“ ”) around a placeholder, or double the
 * apostrophe ('') when a straight one is genuinely wanted.
 */

function flatten(value: unknown, prefix = '', out: Record<string, string> = {}): Record<string, string> {
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (typeof child === 'string') out[path] = child
    else if (child && typeof child === 'object') flatten(child, path, out)
  }
  return out
}

function escapedBraces(message: string): boolean {
  let found = false
  const walk = (elements: ReturnType<typeof parse>): void => {
    for (const el of elements) {
      if (el.type === TYPE.literal) {
        if (el.value.includes('{') || el.value.includes('}')) found = true
      } else if (el.type === TYPE.plural || el.type === TYPE.select) {
        for (const option of Object.values(el.options)) walk(option.value)
      } else if (el.type === TYPE.tag) {
        walk(el.children)
      }
    }
  }
  walk(parse(message))
  return found
}

describe('English source copy', () => {
  it('never lets ICU quoting swallow a placeholder', () => {
    const offenders = Object.entries(flatten(translations))
      .filter(([, value]) => escapedBraces(value))
      .map(([key, value]) => `${key}: ${value}`)

    expect(offenders).toEqual([])
  })
})
