/**
 * Web HTML shell for Expo Router.
 *
 * Declares Inter @font-face rules directly in the <head> so the
 * fonts are available before React mounts — preventing the flash of
 * system font that occurs when relying solely on the useFonts() JS injection.
 *
 * This file is web-only; it is ignored on native platforms.
 *
 * @module
 */

import {ScrollViewStyleReset} from 'expo-router/html'
import type {PropsWithChildren} from 'react'

/**
 * @font-face declarations for Inter.
 *
 * Paths are served by Metro's static asset handler in development
 * and copied to the export output directory in production builds.
 *
 * font-weight: 100 900 — React Native Web emits `font-family: 'Inter-Medium'`
 * with NO explicit font-weight (defaults to normal/400). Declaring a narrow weight
 * like 500 or 700 here causes a CSS mismatch and the browser falls back to the
 * system font. Using 100 900 makes each named family match any weight request,
 * which is the correct approach when weight is encoded in the family name (RN style).
 *
 * font-display: block hides text until the font is ready (FOIT), which is
 * preferable to a flash of unstyled system text (FOUT) for a wallet UI.
 *
 * font-feature-settings: 'liga' off, 'clig' off — matches Figma spec exactly;
 * disables contextual ligatures that would alter letter shapes.
 */

/**
 * RN Web: avoid a **second** UA focus ring on pointer/touch focus only.
 *
 * Uses `:focus:not(:focus-visible)` so keyboard `:focus-visible` outlines stay for native HTML
 * controls and third-party widgets (WCAG 2.4.7). Do **not** use blanket `input:focus` or
 * `border: none` globally — too broad. [`TextInputBase`](../src/components/TextInputBase.tsx) merges
 * `webTextInputFocusResetStyle` on web only when **not** passing `allowBrowserFocusRing` — use that prop
 * on standalone search/filter fields so keyboard `:focus-visible` is not killed by inline outline reset.
 */
const globalResetCSS = `
  input:focus:not(:focus-visible),
  textarea:focus:not(:focus-visible) {
    outline: none;
  }
`

const fontFaceCSS = `
  @font-face {
    font-family: 'Inter-Regular';
    src: url('/assets/fonts/Inter-Regular.ttf') format('truetype');
    font-weight: 100 900;
    font-style: normal;
    font-display: block;
  }
  @font-face {
    font-family: 'Inter-Medium';
    src: url('/assets/fonts/Inter-Medium.ttf') format('truetype');
    font-weight: 100 900;
    font-style: normal;
    font-display: block;
  }
  @font-face {
    font-family: 'Inter-SemiBold';
    src: url('/assets/fonts/Inter-SemiBold.ttf') format('truetype');
    font-weight: 100 900;
    font-style: normal;
    font-display: block;
  }
  @font-face {
    font-family: 'Inter-Bold';
    src: url('/assets/fonts/Inter-Bold.ttf') format('truetype');
    font-weight: 100 900;
    font-style: normal;
    font-display: block;
  }
`

export default function Root({children}: PropsWithChildren) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no" />
        {/* Suppress ScrollView style bleed on web */}
        <ScrollViewStyleReset />
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: static CSS string, no user input */}
        <style dangerouslySetInnerHTML={{__html: globalResetCSS}} />
        {/* Load Inter before React renders to prevent flash of system font */}
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: static CSS string, no user input */}
        <style dangerouslySetInnerHTML={{__html: fontFaceCSS}} />
      </head>
      <body>{children}</body>
    </html>
  )
}
