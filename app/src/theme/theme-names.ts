/**
 * How a theme is named, and how its darkness is read back.
 *
 * ⚠️ **One spelling, in one place, because two consumers read it as a string.** `use-is-dark.ts` and
 * `navigation-header.ts` both branched on `theme.name === 'pnyxDark'`. That worked while there were
 * exactly two themes; adding a scheme axis makes the name `pnyxDark_teal`, and both comparisons
 * would have gone quietly false — reporting dark mode as light, which is not a crash but a wrong
 * status bar and a wrong branch everywhere `useIsDark` is consulted.
 *
 * So the name is built here and interrogated here. A caller that wants to know whether a theme is
 * dark asks {@link isDarkThemeName} rather than comparing to a literal.
 *
 * @module
 */

import type {AccentName} from './accent-ramps'

/** The registered Unistyles name for a scheme in a mode. Also the theme object's own `name`. */
export const themeNameFor = (accent: AccentName, dark: boolean): string => `pnyx${dark ? 'Dark' : 'Light'}_${accent}`

/**
 * Is this theme a dark one?
 *
 * Prefix-based, so it holds for every scheme and for the two legacy `pnyxLight` / `pnyxDark` keys
 * that `configureUnistyles` still names as an initial theme.
 */
export const isDarkThemeName = (name: string): boolean => name.startsWith('pnyxDark')
