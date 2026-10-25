/**
 * Chamfered-corner paint layers.
 *
 * React Native cannot clip a View to an arbitrary path, so a bevelled corner is
 * drawn as an SVG path rather than expressed as a border style. Two entry points:
 *
 * - `ChamferBackground` fills its parent and paints only — drop it in as the first
 *   child of a container that already owns its layout and press states.
 * - `ChamferSurface` is the same paint plus its own box, for callers that would
 *   otherwise add a wrapper View.
 *
 * Both need real pixel dimensions, so the fill lands on the layout pass after
 * mount. Children are never clipped to the cut: content drawn edge-to-edge inside
 * a chamfered container will still poke past the corner.
 *
 * A box too large to rasterise is not painted at all — see `paint-budget`.
 *
 * @module
 */

import {memo, type ReactNode, useEffect, useId, useState} from 'react'
import {type LayoutChangeEvent, PixelRatio, StyleSheet as RNStyleSheet, View, type ViewStyle} from 'react-native'
import Svg, {Defs, LinearGradient, Path, Stop} from 'react-native-svg'
import {StyleSheet} from 'react-native-unistyles'
import {logger} from '../../logger'
import {platformIsWeb} from '../../platform'
import type {NewColorTokens} from '../../theme/tokens'
import {type ChamferCut, chamferBracketPaths, chamferPath, chamferSizeForHeight} from './chamfer-path'
import {type ChamferedStyle, chamferedSurfaceStyle} from './owned-surface'
import {paintFitsBudget} from './paint-budget'
import {UniPath} from './UniPath'

export type ChamferBrackets = {
  readonly colorToken: keyof NewColorTokens
  readonly width?: number
  readonly armLength?: number
}

/**
 * The house bracket highlight.
 *
 * One definition because it is an *affordance*, not a decoration: a card and a quick action bracketed
 * differently would read as two different signals. Module-level so it is referentially stable —
 * `ChamferBackground` is memoised and a fresh object every render defeats that.
 */
export const HIGHLIGHT_BRACKETS: ChamferBrackets = {colorToken: 'primaryDefault', width: 2}

/** Cut length in points, or `'auto'` to scale it to the measured height. */
export type ChamferSize = number | 'auto'

export type ChamferPaintProps = {
  readonly size: ChamferSize
  /** Which corners to cut. Defaults to the house diagonal (top-right + bottom-left). */
  readonly cut?: ChamferCut
  /** Solid colour, or two stops for a gradient along the cut axis. */
  readonly fill?: string | readonly [string, string] | undefined
  readonly borderColor?: string | undefined
  readonly borderWidth?: number | undefined
  /**
   * Theme-token forms of `fill` / `borderColor`, and the form to prefer: the token
   * is resolved by Unistyles against the painted `Path`. A caller that resolves the
   * colour itself needs a `useUnistyles()` subscription to do it, which opts that
   * caller out of the native theme update for every surface it owns.
   */
  readonly fillToken?: keyof NewColorTokens | undefined
  readonly borderToken?: keyof NewColorTokens | undefined
  /** Dashes the stroke, for the "empty slot" / "already used" affordances. */
  readonly borderDashed?: boolean | undefined
  /**
   * Top-down white highlight clipped to the cut, replacing the inset box-shadow a
   * rounded surface would use — a shadow cannot follow a bevel.
   */
  readonly sheen?: number | undefined
  /** HUD-style corner brackets stroked over the cut corners. */
  readonly brackets?: ChamferBrackets | undefined
}

export type ChamferSurfaceProps = ChamferPaintProps & {
  /** Layout and spacing only — the surface owns its corner and its fill. */
  readonly style?: ChamferedStyle | undefined
  readonly children?: ReactNode
  readonly testID?: string | undefined
}

type Size = {width: number; height: number}

const useMeasuredSize = () => {
  const [layout, setLayout] = useState<Size | null>(null)

  const onLayout = (event: LayoutChangeEvent) => {
    const {width, height} = event.nativeEvent.layout

    setLayout((current) =>
      current && current.width === width && current.height === height ? current : {width, height},
    )
  }

  return [layout, onLayout] as const
}

const ChamferPaint = memo(
  ({
    layout,
    size,
    cut = 'diagonal',
    fill,
    fillToken,
    borderColor,
    borderToken,
    borderWidth = 0,
    borderDashed = false,
    sheen,
    brackets,
  }: ChamferPaintProps & {readonly layout: Size}) => {
    const id = useId()
    const fillId = `chamfer-fill-${id}`
    const sheenId = `chamfer-sheen-${id}`

    // The whole layer rasterises to one bitmap, and Android kills the process rather
    // than throwing when that bitmap is too big for its canvas.
    const fits = paintFitsBudget(layout.width, layout.height, PixelRatio.get())

    useEffect(() => {
      if (!fits) {
        logger.warn('Chamfer paint skipped: the box is larger than one bitmap may be', {
          origin: 'ChamferPaint',
          width: layout.width,
          height: layout.height,
        })
      }
    }, [fits, layout.width, layout.height])

    const strokeWidth = borderToken && borderWidth === 0 ? 1 : borderWidth
    const hasStroke = strokeWidth > 0 && (borderToken !== undefined || borderColor !== undefined)
    // A full stroke width, not half: a stroke is centred on the path, so insetting by
    // half puts its outer edge exactly on the SVG viewport boundary, where the
    // rasteriser drops the last fractional row — asymmetrically. On a 20pt checkbox
    // that left the bottom border at a third of the top's weight.
    const inset = hasStroke ? strokeWidth : 0
    const gradient = typeof fill === 'string' || fill === undefined ? null : fill
    const solid = typeof fill === 'string' ? fill : 'none'
    const cutSize = size === 'auto' ? chamferSizeForHeight(layout.height) : size

    const d = chamferPath({...layout, size: cutSize, cut, inset})

    if (d === '' || !fits) return null

    const bracketPaths = brackets
      ? chamferBracketPaths({
          ...layout,
          size: cutSize,
          cut,
          inset: (brackets.width ?? 1) / 2,
          armLength: brackets.armLength ?? cutSize,
        })
      : []

    return (
      <Svg width={layout.width} height={layout.height} style={PAINT_LAYER} pointerEvents="none">
        <Defs>
          {gradient !== null && (
            <LinearGradient id={fillId} x1="0" y1="0" x2="1" y2="1">
              <Stop offset="0" stopColor={gradient[0]} />
              <Stop offset="1" stopColor={gradient[1]} />
            </LinearGradient>
          )}
          {sheen != null && (
            <LinearGradient id={sheenId} x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor="#FFFFFF" stopOpacity={sheen} />
              <Stop offset="1" stopColor="#FFFFFF" stopOpacity={0} />
            </LinearGradient>
          )}
        </Defs>

        <UniPath
          d={d}
          {...(gradient ? {fill: `url(#${fillId})`} : {})}
          {...(hasStroke ? {strokeWidth} : {})}
          {...(hasStroke && borderDashed ? {strokeDasharray: '4 3'} : {})}
          uniProps={(theme) => ({
            ...(gradient ? {} : {fill: fillToken ? theme.colors[fillToken] : solid}),
            ...(hasStroke ? {stroke: borderToken ? theme.colors[borderToken] : (borderColor ?? 'none')} : {}),
          })}
        />

        {sheen != null && <Path d={d} fill={`url(#${sheenId})`} />}

        {bracketPaths.map((bracket) => (
          <UniPath
            key={bracket}
            d={bracket}
            fill="none"
            strokeWidth={brackets?.width ?? 1}
            strokeLinecap="square"
            uniProps={(theme) => ({stroke: brackets ? theme.colors[brackets.colorToken] : 'none'})}
          />
        ))}
      </Svg>
    )
  },
)

/**
 * Paints a chamfered background across its parent's box. Absolutely positioned and
 * never interactive, so it can be dropped into a Pressable without disturbing
 * layout or swallowing presses.
 *
 * Memoised, so a parent re-rendering for its own reasons does not rebuild the path
 * and the SVG tree. Note this only holds while the props are stable: an inline
 * `brackets={{…}}` object or a fresh `fill` tuple defeats it, so those are built
 * outside the render where it matters.
 */
export const ChamferBackground = memo((props: ChamferPaintProps) => {
  const [layout, onLayout] = useMeasuredSize()

  return (
    <View style={surfaceStyles.fill} pointerEvents="none" onLayout={onLayout}>
      {layout && <ChamferPaint {...props} layout={layout} />}
    </View>
  )
})

/** A chamfered background plus the box it paints, for callers without one. */
export const ChamferSurface = ({style, children, testID, ...paint}: ChamferSurfaceProps) => {
  const [layout, onLayout] = useMeasuredSize()

  return (
    <View style={chamferedSurfaceStyle(style)} onLayout={onLayout} testID={testID}>
      {layout && <ChamferPaint {...paint} layout={layout} />}
      {children}
    </View>
  )
}

/**
 * The paint layer sits under the content it backs.
 *
 * It has to be absolutely positioned to fill the box — and on web an absolutely
 * positioned box paints over its in-flow siblings whatever the DOM order. Most siblings
 * survive that because react-native-web makes a `View` positioned too, but anything it
 * leaves in flow does not: a `TextInput` held the right word and drew it behind the fill.
 * A negative index puts the paint back under the content while staying above the box's own
 * background, which the chamfer contract keeps transparent.
 *
 * Web only. Native paints strictly by order, where the layer is already correct, and
 * Android has its own history with negative z-index.
 *
 * ⚠️ Plain RN styles, NOT `StyleSheet.create` from Unistyles: `Svg` is a react-native-svg
 * component, and the Unistyles babel plugin only rewrites `react-native` imports — so a
 * Unistyles object handed to `Svg` is dropped. That silently unset `position: absolute`,
 * which let the layer grow the very box it measures and feed its own `onLayout`: a runaway
 * 1,067,144px SVG that swallowed the Assets and Transactions sections.
 */
const PAINT_LAYER: ViewStyle = platformIsWeb
  ? {...RNStyleSheet.absoluteFillObject, zIndex: -1}
  : RNStyleSheet.absoluteFillObject

const surfaceStyles = StyleSheet.create(() => ({
  fill: {
    ...RNStyleSheet.absoluteFillObject,
    ...(platformIsWeb ? {zIndex: -1} : {}),
  },
}))
