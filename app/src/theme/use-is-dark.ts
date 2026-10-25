/**
 * Reactive `isDark` check via Unistyles.
 *
 * Replaces the previous `useTheme().isDark` read, which subscribed via the
 * custom ThemeContext in parallel to Unistyles' own subscription. This hook
 * routes the read through the single Unistyles pipeline.
 *
 * Use inside render bodies / hooks. For one-shot non-reactive reads (decision
 * branches outside render), prefer `isDarkThemeName(UnistylesRuntime.themeName)`.
 * For component-prop shapes (image variants, color props), prefer
 * `withUnistyles(Component, (theme) => ({...}))` — see `app/app/settings/backup-verification.tsx:35`.
 *
 * @module
 */

import {useUnistyles} from 'react-native-unistyles'
import {isDarkThemeName} from './theme-names'

export const useIsDark = (): boolean => {
  const {theme} = useUnistyles()
  // Compare by name, not identity: `theme` is a Proxy wrapping the underlying
  // theme object, so `theme === pnyxDark` is always false. The Proxy
  // forwards `.name` reads to the target and registers a Theme dependency,
  // keeping the result reactive.
  //
  // ⚠️ Through `isDarkThemeName`, never against a literal: the name carries the colour scheme too
  // (`pnyxDark_teal`), so `=== 'pnyxDark'` is false for every scheme but the default.
  return isDarkThemeName(theme.name)
}
