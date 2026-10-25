/**
 * What it means to own a chamfered corner.
 *
 * A bevelled surface is a painted SVG path, not a border style, so the four
 * properties below no longer describe the shape — they fight it. A `borderRadius`
 * or `borderWidth` draws a rounded box around the cut one, `overflow: hidden`
 * clips to the rectangle the surface is deliberately not, and a `backgroundColor`
 * fills the corners the path left empty. Under `borderRadius` a caller that
 * re-declared one of these merely got a different radius; under a painted path it
 * deletes the design.
 *
 * So a component that paints a chamfer owns these four on the box it paints, and
 * {@link chamferedSurfaceStyle} re-applies them after the caller's style. The
 * matching {@link ChamferedStyle} type makes the re-declaration a compile error
 * rather than a silently dropped one — declared-but-ignored is the failure mode
 * this whole module exists to avoid.
 *
 * A caller that needs a different fill uses the component's own affordance
 * (`Card`'s `fill` / `fillToken`, `ChamferSurface`'s `fill`), which paints into
 * the path instead of behind it.
 *
 * @module
 */

import type {ViewStyle} from 'react-native'

/**
 * Re-applied last on a painted box, so no caller style can reintroduce a
 * rectangular corner. `overflow: visible` is the assertion, not a default —
 * `hidden` cannot follow a cut, so it silently re-rounds the chamfer.
 */
export const CHAMFER_OWNED_SURFACE = {
  borderRadius: 0,
  borderWidth: 0,
  overflow: 'visible',
  backgroundColor: 'transparent',
} as const satisfies ViewStyle

export type ChamferOwnedProperty = keyof typeof CHAMFER_OWNED_SURFACE

/**
 * A style a caller may hand to a painted surface: anything except the properties
 * the surface owns. `never` rather than `Omit` so passing one is an error instead
 * of being structurally tolerated.
 */
export type ChamferedStyle = Omit<ViewStyle, ChamferOwnedProperty> & {
  readonly [Property in ChamferOwnedProperty]?: never
}

/**
 * Composes a painted box's style, dropping falsy entries and putting the owned
 * corner last. Call it at the single place the painted box's `style` is built.
 */
export const chamferedSurfaceStyle = (...styles: ReadonlyArray<ViewStyle | false | null | undefined>): ViewStyle[] => [
  ...styles.filter((style): style is ViewStyle => Boolean(style)),
  CHAMFER_OWNED_SURFACE,
]
