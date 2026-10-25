/**
 * A QR code on its card.
 *
 * **The white surface and the padding are scanability, not decoration.** {@link QRCode} renders with
 * `margin: 0`, so the quiet zone the QR spec requires around a symbol comes from this card's
 * padding — a code drawn straight onto a dark surface has none, and scanners can fail to lock on.
 * That is why the surface is `theme.colors.white` (theme-invariant) rather than a token that flips
 * with the theme.
 *
 * ⚠️ **And it is four *modules*, not twenty points.** The padding used to be a fixed
 * `spacing20`, which is 4.1 modules around a 41-module address and 8.9 around an 89-module pairing
 * token — so the densest codes were padded out of the width they needed most. It is derived from the
 * value's own density now (`qr-quiet-zone.ts`), which lands on the same ~20 pt for an address and gives
 * a dense code its space back.
 *
 * One card for every QR the user is meant to scan. Four screens had grown four near-identical
 * hand-rolled wrappers with drifted padding and surfaces, which is exactly what
 * `CLAUDE.md` → "Standardization rule" is about.
 *
 * @module
 */

import {memo, useMemo, useState} from 'react'
import {View} from 'react-native'
import {StyleSheet, useUnistyles} from 'react-native-unistyles'
import {ChamferBackground} from './Chamfer'
import {QRCode, type QRCodeProps} from './QRCode'
import {moduleCountFor, quietZoneForEdge, quietZoneForFill} from './qr-quiet-zone'

export type QRCardProps = {
  /** The value to encode. */
  readonly value: string
  /** Edge length of the code itself. Ignored under `fill`. */
  readonly size?: number
  /**
   * Stretch across the container and draw the code as large as the padding leaves room for.
   *
   * A camera locks onto a QR by module, not by symbol, so a dense code is a question of how many
   * screen pixels one module gets. For anything near the capacity of its version — an animated UR
   * frame above all — the available width is the right size and any fixed one is too small.
   */
  readonly fill?: boolean
  /** See {@link QRCodeProps.keepPreviousWhileEncoding} — only for a presenter cycling one payload. */
  readonly keepPreviousWhileEncoding?: boolean
  readonly testID?: string
}

const QRCardInner = ({value, size = 200, fill = false, keepPreviousWhileEncoding = false, testID}: QRCardProps) => {
  const {theme} = useUnistyles()
  const [available, setAvailable] = useState<number | null>(null)
  styles.useVariants({fill})

  // One extra encode per value to learn its density. Sub-millisecond even for the densest code we
  // generate, and memoised — the alternative is a padding that ignores what it is padding.
  const moduleCount = useMemo(() => moduleCountFor(value), [value])

  // ⚠️ The **card** is measured, not the slot inside it. The slot's width is already the padding's
  // leftover, so deriving padding from it would subtract the quiet zone twice — and worse, applying the
  // result would change the slot's width and measure again. The card's own width does not depend on its
  // padding under `stretch`, so one measurement settles it and the rest is arithmetic.
  const layout =
    fill && available !== null
      ? quietZoneForFill(available, moduleCount)
      : {padding: quietZoneForEdge(size, moduleCount), edge: size}
  // Under `fill` the first pass has nothing to draw at: the slot holds the square open so the
  // measured code does not shove the rest of the screen down when it arrives.
  const edge = fill ? (available === null ? null : layout.edge) : size

  return (
    <View
      style={[styles.card, {padding: layout.padding}]}
      onLayout={fill ? (event) => setAvailable(Math.floor(event.nativeEvent.layout.width)) : undefined}
    >
      <ChamferBackground
        size="auto"
        fill={theme.colors.white}
        borderColor={theme.colors.borderDefaultWeak}
        borderWidth={1}
      />
      <View style={[styles.slot, edge === null ? null : {width: edge, height: edge}]}>
        {edge === null ? null : (
          <QRCode
            value={value}
            size={edge}
            keepPreviousWhileEncoding={keepPreviousWhileEncoding}
            {...(testID === undefined ? {} : {testID})}
          />
        )}
      </View>
    </View>
  )
}

const styles = StyleSheet.create(() => ({
  card: {
    // No `padding` here: it is the quiet zone and belongs to the code's density, not to the spacing
    // scale — a token that moved would change a scanning property.
    //
    // The border earns its place in light mode, where a white card on a near-white
    // canvas would otherwise have no edge. In dark mode the card's own white does
    // the lifting, so nothing else is needed.
    variants: {
      fill: {
        true: {alignSelf: 'stretch'},
        false: {alignSelf: 'center'},
      },
    },
  },
  slot: {
    variants: {
      fill: {
        true: {aspectRatio: 1},
        false: {},
      },
    },
  },
}))

/**
 * Memoised for the same reason {@link QRCode} is: a parent that sets state a few times — a screen
 * issuing a credential and refreshing its list — would otherwise re-render the card, and through it the
 * SVG parse. Every prop is a primitive, so the compare is exact.
 */
export const QRCard = memo(QRCardInner)
