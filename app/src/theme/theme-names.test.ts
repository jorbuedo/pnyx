import {describe, expect, it} from 'vitest'

import {accentNames} from './accent-ramps'
import {isDarkThemeName, themeNameFor} from './theme-names'

describe('themeNameFor', () => {
  it('gives every scheme a distinct name in each mode', () => {
    const names = accentNames.flatMap((accent) => [themeNameFor(accent, false), themeNameFor(accent, true)])
    expect(new Set(names).size).toBe(names.length)
    expect(names).toHaveLength(24)
  })
})

describe('isDarkThemeName', () => {
  // ⚠️ The regression this exists to prevent. `use-is-dark.ts` and `navigation-header.ts` compared
  // `theme.name === 'pnyxDark'`; once the name carries a scheme, that is false for eleven of the
  // twelve dark themes — dark mode reporting itself as light, with no error anywhere.
  it('recognises every scheme’s dark theme, not just the default', () => {
    for (const accent of accentNames) {
      expect(isDarkThemeName(themeNameFor(accent, true)), accent).toBe(true)
      expect(isDarkThemeName(themeNameFor(accent, false)), accent).toBe(false)
    }
  })

  it('still recognises the legacy two-theme names', () => {
    expect(isDarkThemeName('pnyxDark')).toBe(true)
    expect(isDarkThemeName('pnyxLight')).toBe(false)
  })
})
