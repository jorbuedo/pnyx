import {describe, expect, it} from 'vitest'
import {translations} from './translations'

/**
 * Em dashes are banned in user-facing copy. Use a period, colon, comma or
 * parentheses instead. The only survivors are the two keys below, where the
 * glyph is a "no value yet" placeholder rather than prose.
 */
const GLYPH_PLACEHOLDERS = ['you.handle.screen.tierUnknown']

function flatten(value: unknown, prefix = '', out: Record<string, string> = {}): Record<string, string> {
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (typeof child === 'string') out[path] = child
    else if (child && typeof child === 'object') flatten(child, path, out)
  }
  return out
}

describe('English source copy', () => {
  it('contains no em dashes outside the placeholder glyphs', () => {
    const offenders = Object.entries(flatten(translations))
      .filter(([key, value]) => value.includes('—') && !GLYPH_PLACEHOLDERS.includes(key))
      .map(([key, value]) => `${key}: ${value}`)

    expect(offenders).toEqual([])
  })

  it('still carries the placeholder glyphs the allowlist exempts', () => {
    const flat = flatten(translations)
    for (const key of GLYPH_PLACEHOLDERS) expect(flat[key]).toBe('—')
  })
})
