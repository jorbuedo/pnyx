/**
 * Shared form chrome for the onboarding screens
 * (`secure-with-biometrics.tsx`).
 *
 * Canonical version of the 44-tall input row with a 12px radius and the
 * locked lineHeight that keeps 14px glyphs centered on iOS.
 *
 * @module
 */

import type {TextStyle, ViewStyle} from 'react-native'

/**
 * The 44-tall input row, hard-set instead of inheriting the shared `TextInput`'s default 56
 * (`size="md"`). A raw style on purpose: `inputContainerStyle` takes a plain `ViewStyle` and
 * nothing here needs theming, because the border and the background are drawn by the
 * `ChamferBackground` *inside* that container.
 *
 * ⚠️ **No `borderWidth` here, and that is the fix rather than an omission.** This style lands on
 * `TextInput`'s outer `Animated.View`, which has no border of its own and no `borderColor` — so a
 * width alone painted a second rectangle in React Native's default black, around the chamfered
 * one. It was invisible in dark mode, where black reads as the background, and showed as a stray
 * rounded box in light mode.
 */
export const protoInputStyle: ViewStyle = {
  height: 44,
  borderRadius: 12,
  paddingHorizontal: 14,
}

/**
 * Tighter lineHeight inside the proto-input. The shared `TextInput` defaults
 * to lineHeight 22 for fontSize 14 — correct in a 56-tall box, but renders
 * bottom-heavy on iOS when the box is shrunk to 44 (RN puts the extra leading
 * above the cap line). 18 ≈ the browser's `line-height: normal` for a 14px
 * input and keeps glyphs visually centered in the 42px content area.
 */
export const protoInputTextStyle: TextStyle = {
  lineHeight: 18,
}
