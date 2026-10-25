import {describe, expect, it} from 'vitest'

import {type ButtonIconVariant, buttonIconFill, buttonIconIsPainted, buttonIconSurfaces} from './button-icon-surface'

const variants = Object.keys(buttonIconSurfaces) as readonly ButtonIconVariant[]

describe('buttonIconFill', () => {
  it('swaps a painted variant to its pressed fill', () => {
    expect(buttonIconFill('primary', false)).toBe('primaryAlternative')
    expect(buttonIconFill('primary', true)).toBe('primaryAlternativePressed')
    expect(buttonIconFill('overlayDark', true)).toBe('btnIconOverlayDarkPressed')
  })

  it('paints a naked variant only under a finger', () => {
    expect(buttonIconFill('alternativeNaked', false)).toBeNull()
    expect(buttonIconFill('alternativeNaked', true)).toBe('backgroundAlternativePressed')
  })

  it('leaves the plain naked variant unpainted in both states', () => {
    expect(buttonIconFill('naked', false)).toBeNull()
    expect(buttonIconFill('naked', true)).toBeNull()
  })

  it('paints nothing for the circular variant, which owns its corner as a radius', () => {
    expect(buttonIconFill('subtleCircular', false)).toBeNull()
    expect(buttonIconFill('subtleCircular', true)).toBeNull()
    expect(buttonIconIsPainted('subtleCircular')).toBe(false)
  })

  it('never drops a resting fill on press, whatever the variant', () => {
    for (const variant of variants) {
      const resting = buttonIconFill(variant, false)

      if (resting !== null) expect(buttonIconFill(variant, true)).not.toBeNull()
    }
  })
})
