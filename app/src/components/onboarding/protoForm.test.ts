import {describe, expect, it} from 'vitest'
import {protoInputStyle, protoInputTextStyle} from './protoForm'

describe('protoInputStyle', () => {
  it('declares no border, because the one the user sees is drawn inside the container', () => {
    // ⚠️ This style lands on `TextInput`'s outer `Animated.View`, which has no border and no
    // `borderColor`. A `borderWidth` here therefore paints a second rectangle in React Native's
    // default black around the chamfered one — invisible in dark mode, where black reads as the
    // background, and a stray rounded box in light mode. Shipped that way until a screenshot.
    expect(protoInputStyle).not.toHaveProperty('borderWidth')
    expect(protoInputStyle).not.toHaveProperty('borderColor')
  })

  it('keeps the 44-tall row the layout is built around', () => {
    // Hard-set rather than derived: the shared input defaults to 56 at `size="md"`, and the
    // height is what the surrounding spacing was measured against.
    expect(protoInputStyle.height).toBe(44)
  })

  it('keeps the tighter lineHeight that centers 14px glyphs on iOS', () => {
    // The shared input's 22 is correct in a 56-tall box and renders bottom-heavy in a 44-tall
    // one, because RN puts the extra leading above the cap line.
    expect(protoInputTextStyle.lineHeight).toBe(18)
  })
})
