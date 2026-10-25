import {describe, expect, it} from 'vitest'

import {flattenToString} from './sensitive-typography-flatten'

describe('flattenToString', () => {
  it('returns the string itself for a string child', () => {
    expect(flattenToString('$12,847.50')).toBe('$12,847.50')
  })

  it('returns the stringified number for a number child', () => {
    expect(flattenToString(42)).toBe('42')
  })

  it('joins an array of string children — fixes the {a}{b} JSX-adjacency case', () => {
    // Reproduces `{fiatSign}{fiatBalanceDisplay}` — React hands the component
    // an array, and the previous `typeof === 'string'` check missed it.
    expect(flattenToString(['$', '12,847.50'])).toBe('$12,847.50')
  })

  it('joins arrays mixing strings and numbers', () => {
    expect(flattenToString(['$', 12, '.', 50])).toBe('$12.50')
  })

  it('skips null / undefined / boolean entries (React ignores them at render too)', () => {
    expect(flattenToString(['$', null, '12', undefined, '.50', false])).toBe('$12.50')
  })

  it('returns undefined when any array entry is non-primitive', () => {
    // `{...}` containing a non-primitive — fall back to the default placeholder.
    expect(flattenToString(['$', {} as never])).toBeUndefined()
  })

  it('returns undefined for non-primitive single children', () => {
    expect(flattenToString({} as never)).toBeUndefined()
    expect(flattenToString(null)).toBeUndefined()
    expect(flattenToString(undefined)).toBeUndefined()
  })
})
