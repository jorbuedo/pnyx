import {type AccentName, schemes} from '../accent-ramps'
import {baseStaticTheme, borderRadius, createTextVariants, pnyxFontFamily} from '../base'
import {themeNameFor} from '../theme-names'
import type {BaseTheme} from '../tokens'
import {darkColors, lightColors} from './pnyx-colors'

export {darkColors, lightColors} from './pnyx-colors'

/** The light theme for one colour scheme. */
export const pnyxLightFor = (accent: AccentName): BaseTheme => ({
  name: themeNameFor(accent, false),
  colors: lightColors(schemes[accent]),
  ...baseStaticTheme,
  textVariants: createTextVariants(pnyxFontFamily),
  fontFamily: pnyxFontFamily,
  // Buttons use a 12 px corner radius
  // — rounded rectangles, not pills.
  buttonBorderRadius: borderRadius.rounded12,
})

/** The dark theme for one colour scheme. */
export const pnyxDarkFor = (accent: AccentName): BaseTheme => ({
  name: themeNameFor(accent, true),
  colors: darkColors(schemes[accent]),
  ...baseStaticTheme,
  textVariants: createTextVariants(pnyxFontFamily),
  fontFamily: pnyxFontFamily,
  // Buttons use a 12 px corner radius
  // — rounded rectangles, not pills.
  buttonBorderRadius: borderRadius.rounded12,
})
