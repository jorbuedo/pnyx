/**
 * Which surface each ButtonIcon variant draws, and what it draws on press.
 *
 * Split out of the component because it is the rule the chamfer makes easy to get
 * wrong: a painted variant's press feedback has to be a swap of the *painted*
 * fill. A `backgroundColor` on the pressable would paint a square behind the cut
 * shape, so the corners fill in and the bevel vanishes for as long as the finger
 * is down.
 *
 * `subtleCircular` is the exception — it is deliberately a circle, so it owns its
 * corner through plain style rules and paints nothing.
 *
 * @module
 */

import type {NewColorTokens} from '../../theme/tokens'

/** Available button icon variants. Re-exported from `ButtonIcon` for callers. */
export type ButtonIconVariant =
  | 'naked'
  | 'primary'
  | 'alternativeNaked'
  | 'errorNaked'
  | 'invertedNaked'
  | 'overlayDark'
  | 'overlayLight'
  | 'subtleCircular'

export type ButtonIconSurface =
  | {
      readonly kind: 'painted'
      /** `null` for the naked variants: nothing at rest, a fill only under a finger. */
      readonly restingFill: keyof NewColorTokens | null
      readonly pressedFill: keyof NewColorTokens | null
    }
  | {readonly kind: 'circle'}

export const buttonIconSurfaces: Record<ButtonIconVariant, ButtonIconSurface> = {
  primary: {kind: 'painted', restingFill: 'primaryAlternative', pressedFill: 'primaryAlternativePressed'},
  naked: {kind: 'painted', restingFill: null, pressedFill: null},
  alternativeNaked: {kind: 'painted', restingFill: null, pressedFill: 'backgroundAlternativePressed'},
  errorNaked: {kind: 'painted', restingFill: null, pressedFill: 'errorPressed'},
  invertedNaked: {kind: 'painted', restingFill: null, pressedFill: 'primaryPressed'},
  overlayDark: {kind: 'painted', restingFill: 'btnIconOverlayDark', pressedFill: 'btnIconOverlayDarkPressed'},
  overlayLight: {kind: 'painted', restingFill: 'btnIconOverlayLight', pressedFill: 'btnIconOverlayLightPressed'},
  subtleCircular: {kind: 'circle'},
}

/**
 * The fill token to paint for a variant in a given press state, or `null` when
 * there is nothing to paint (a circle, or a naked variant at rest).
 */
export const buttonIconFill = (variant: ButtonIconVariant, isPressed: boolean): keyof NewColorTokens | null => {
  const surface = buttonIconSurfaces[variant]

  if (surface.kind === 'circle') return null
  if (isPressed) return surface.pressedFill ?? surface.restingFill

  return surface.restingFill
}

/** Whether the variant's box is painted, and so owns its corner. */
export const buttonIconIsPainted = (variant: ButtonIconVariant): boolean =>
  buttonIconSurfaces[variant].kind === 'painted'
