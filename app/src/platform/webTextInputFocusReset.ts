/**
 * Web-only patch for React Native `TextInput` / `TextInput`-like controls inside **custom chrome**
 * (bordered containers, animated wrappers, etc.).
 *
 * Global CSS in `+html.tsx` only removes the UA outline for **pointer** focus
 * (`:focus:not(:focus-visible)`), so keyboard users keep the default `:focus-visible` ring on
 * unstyled controls (WCAG 2.4.7). Where the parent already shows focus, merge
 * {@link webTextInputFocusResetStyle} on the inner native control so keyboard navigation does not
 * draw a second frame.
 *
 * Do **not** merge on standalone fields: use [`TextInputBase`](../components/TextInputBase.tsx) with
 * `allowBrowserFocusRing` instead. Do **not** use on raw `<input>` / third-party widgets unless they
 * duplicate focus affordance.
 *
 * @module
 */

import {Platform, type TextStyle} from 'react-native'

/** RN `TextStyle` omits `outlineStyle: 'none'` (web-only); `as unknown as TextStyle` satisfies strict checking. */
const WEB_TEXT_INPUT_FOCUS_RESET = {
  outlineStyle: 'none',
  outlineWidth: 0,
  outlineOffset: 0,
  boxShadow: 'none',
} as unknown as TextStyle

/** Stable empty object for native — no per-render allocation. */
const NATIVE_TEXT_INPUT_FOCUS_RESET = {} as TextStyle

/**
 * Merge into `TextInput` `style` arrays. On native this is a shared empty object (no-op).
 * On web this is a single shared style object (not freshly allocated each render).
 */
export const webTextInputFocusResetStyle: TextStyle =
  Platform.OS === 'web' ? WEB_TEXT_INPUT_FOCUS_RESET : NATIVE_TEXT_INPUT_FOCUS_RESET
