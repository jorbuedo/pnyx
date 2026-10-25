/**
 * Base text input for the app: forwards to React Native `TextInput`.
 *
 * On web, merges [`webTextInputFocusResetStyle`](../platform/webTextInputFocusReset.ts) **unless**
 * {@link TextInputBaseProps.allowBrowserFocusRing} is set — use that for standalone fields (search,
 * filters) so keyboard `:focus-visible` is not overridden by inline outline reset (WCAG 2.4.7). Omit
 * the prop when a parent already shows focus (design-system [`TextInput`](./TextInput.tsx), etc.) so
 * the inner control does not duplicate the ring.
 *
 * **Web only** merges through {@link StyleSheet.flatten}: RN Web can mishandle `style={[a, b]}` on
 * `TextInput` and drop or distort padding (floated-label layouts). ⚠️ On **native** the array is
 * passed through untouched, because flattening it there dropped the styles instead: a Unistyles
 * sheet entry did not survive `flatten`, so a labelled field silently rendered with RN's defaults
 * and every attempt to space its floated label away from the value did nothing at all.
 *
 * **The placeholder colour has a themed default.** It lands on a native prop rather than a style, so
 * without one RN uses the platform's own grey — which on this app's dark surfaces reads as near-black
 * and made placeholders look like a rendering bug. Eight call sites were relying on that default. A
 * caller's own `placeholderTextColor` still wins: `withUnistyles` merges the mapper *under* the props.
 *
 * @module
 */

import {forwardRef} from 'react'
import {Platform, TextInput as RNTextInput, StyleSheet, type TextInputProps} from 'react-native'
import {withUnistyles} from 'react-native-unistyles'

import {webTextInputFocusResetStyle} from '../platform/webTextInputFocusReset'

/** `theme.colors.textAlternative` is the placeholder token the design-system input already uses. */
const ThemedTextInput = withUnistyles(RNTextInput, (theme) => ({
  placeholderTextColor: theme.colors.textAlternative,
}))

export type TextInputBaseProps = TextInputProps & {
  /**
   * When true, skip merging {@link webTextInputFocusResetStyle} on web so the UA can draw
   * `:focus-visible` (standalone search, list filters, plain bordered fields). When false/omitted,
   * merge the reset when parent chrome already indicates focus.
   */
  allowBrowserFocusRing?: boolean
}

export const TextInputBase = forwardRef<RNTextInput, TextInputBaseProps>(
  ({style, allowBrowserFocusRing, ...props}, ref) => {
    const merged = allowBrowserFocusRing === true ? style : [style, webTextInputFocusResetStyle]
    // The reset is an empty object on native, so there is nothing to merge there.
    const resolvedStyle = Platform.OS === 'web' ? StyleSheet.flatten(merged) : merged
    return <ThemedTextInput ref={ref} {...props} style={resolvedStyle} />
  },
)

TextInputBase.displayName = 'TextInputBase'
