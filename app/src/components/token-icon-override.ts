/**
 * Local token-icon overrides for tokens whose on-chain / CDN icon renders badly
 * in-app. NIGHT's official icon is a monochrome glyph shipped in black *or*
 * white; the black artwork vanishes on dark themes, so we substitute the
 * theme-appropriate local asset (light theme → black glyph, dark theme → white
 * glyph). NIGHT only.
 *
 * @module
 */

import type {ImageSource} from 'expo-image'

// NIGHT Cardano native-token policy id (mainnet). Inlined so the icon override
// stands alone — NIGHT still renders as a held asset after the claim flow moved
// to an external dapp.
const NIGHT_POLICY_ID = '0691b2fecca1ac4f53cb6dfb00b7013e561d1f34403b957cbb5af1fa'

// require() must be static — Metro and the web bundler resolve these at build
// time. `expo-image` renders a required `.svg` as an ImageSource (see
// UniIcon.map.ts). Names read by theme, not by artwork colour: the light theme
// needs the black glyph, the dark theme the white one.
const nightGlyphForLight: ImageSource = require('../../assets/icons/NightDark.svg')
const nightGlyphForDark: ImageSource = require('../../assets/icons/NightLight.svg')

/**
 * A local icon override for `assetId` (app id `"policyHex.assetNameHex"`) under
 * the active theme, or `null` when none applies (caller falls back to the CDN
 * icon / initials).
 */
/**
 * Whether `assetId` has a local override at all — **without reading the theme**.
 *
 * ⚠️ The point of splitting this out. Resolving the override needs to know light from dark, and the
 * only way to know is `useUnistyles()`, which opts the calling component out of Unistyles' native
 * shadow-tree update and re-renders it in JS on every runtime notification. `TokenIcon` called it
 * unconditionally, so every icon in a list paid that subscription — measured at 321ms inclusive
 * while scrolling — so that ONE policy could pick between two glyphs. Callers test this first and
 * only the matching row subscribes.
 */
export const hasTokenIconOverride = (assetId: string): boolean => assetId.startsWith(`${NIGHT_POLICY_ID}.`)

export const resolveTokenIconOverride = (assetId: string, isDark: boolean): ImageSource | null => {
  if (assetId.startsWith(`${NIGHT_POLICY_ID}.`)) return isDark ? nightGlyphForDark : nightGlyphForLight
  return null
}
