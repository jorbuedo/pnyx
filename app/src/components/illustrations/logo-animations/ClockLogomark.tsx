import {useEffect} from 'react'
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedProps,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated'
import Svg, {G, Path, Rect} from 'react-native-svg'
import {useUnistyles} from 'react-native-unistyles'

import {
  BOWL_D,
  BOWL_LID_D,
  BOWL_LID_LENGTH,
  BOWL_STROKE,
  COLUMN_PIVOT,
  COLUMN_SIZE,
  COLUMNS,
  lidFill,
  SEAT_D,
  SEAT_LENGTH,
  SEAT_STROKE,
  seatFill,
  turnAngle,
} from './geometry'

const AnimatedG = Animated.createAnimatedComponent(G)
const AnimatedPath = Animated.createAnimatedComponent(Path)

/** One second per quarter turn; two quarters make a cycle. */
const QUARTER_MS = 1000
const CYCLE_QUARTERS = 2
const EASE = Easing.inOut(Easing.cubic)
/** Enough to read as alive on arrival, then still. See `cycles` for why it is not infinite. */
const DEFAULT_CYCLES = 3

export type ClockLogomarkProps = {
  width?: number
  /** Mark color; defaults to the brand logo color (violet on light, lilac on dark). */
  color?: string
  /** Multiplies every duration — 2 plays at half speed. */
  speed?: number
  /**
   * Turn cycles to play before resting on the Pnyx mark. `-1` turns forever.
   *
   * ⚠️ **Not a taste setting.** A perpetual animation means UiAutomator never observes an idle UI,
   * so `uiautomator dump` on the hosting screen fails with "could not get idle state" — which takes
   * maestro, every UiAutomator-driven e2e, and any coordinate read down with it. The welcome screen
   * is the app's first, so looping there made the first screen untestable. Finite by default; pass
   * `-1` only somewhere nothing needs to read the tree, like the playground.
   */
  cycles?: number
}

/**
 * The mark as a clock, resting alternately on two complete forms, a second apart:
 *
 * - **on the beat** — bowl open, seat drawn, columns horizontal: the Pnyx mark.
 * - **off the beat** — bowl closed into a ring, seat withdrawn, columns stacked
 *   vertically: Midnight's mark. The two share dot size and spacing exactly
 *   (see geometry.test.ts).
 *
 * Between them the lid sweeps left to right and back, the seat draws out and in,
 * and the column row turns as one rigid group about its middle column — the
 * outer two swinging round it while all three turn with them.
 */
export const ClockLogomark = ({width = 184, color, speed = 1, cycles = DEFAULT_CYCLES}: ClockLogomarkProps) => {
  const {theme} = useUnistyles()
  const markColor = color ?? theme.colors.logoPrimary
  const height = width * (175 / 174)
  const scale = speed > 0 ? speed : 1

  /**
   * The one animated value: quarter turns elapsed, 0 → 2 and round again. Every
   * moving part reads off it, which is the only way they stay in phase — separate
   * animations differ by a frame per cycle and visibly walk apart within minutes.
   */
  const progress = useSharedValue(0)

  useEffect(() => {
    const quarter = (to: number) => withTiming(to, {duration: QUARTER_MS * scale, easing: EASE})

    /**
     * Two quarters land the row on 180°, which maps it onto itself, and leave the
     * seat and lid exactly as they started — so the reset back to 0 is invisible
     * and progress never has to grow without bound.
     */
    // The sequence's last step returns progress to 0, so however many cycles run, the mark comes
    // to rest on the Pnyx form rather than mid-sweep.
    progress.value = withRepeat(
      withSequence(quarter(1), quarter(CYCLE_QUARTERS), withTiming(0, {duration: 0})),
      cycles,
      false,
    )

    return () => cancelAnimation(progress)
  }, [progress, scale, cycles])

  const seatProps = useAnimatedProps(() => ({
    strokeDasharray: [SEAT_LENGTH, SEAT_LENGTH],
    strokeDashoffset: SEAT_LENGTH * (1 - seatFill(progress.value)),
  }))

  /** BOWL_LID_D runs left tip → right tip, so draining the dash offset closes left to right. */
  const lidProps = useAnimatedProps(() => ({
    strokeDasharray: [BOWL_LID_LENGTH, BOWL_LID_LENGTH],
    strokeDashoffset: BOWL_LID_LENGTH * (1 - lidFill(progress.value)),
  }))

  /**
   * A pure rotation, no translation: the row sits at the height from which the
   * vertical stack already clears the closed ring.
   *
   * Spelled as a React Native transform list rather than SVG's `rotate(a cx cy)`:
   * an animated `transform` goes through RN's transform parser, which rejects the
   * SVG three-argument form and throws once per frame. Translating to the pivot and
   * back is the same rotation in a vocabulary that parser knows.
   */
  const columnsProps = useAnimatedProps(() => ({
    transform: [
      {translateX: COLUMN_PIVOT.cx},
      {translateY: COLUMN_PIVOT.cy},
      {rotate: `${turnAngle(progress.value)}deg`},
      {translateX: -COLUMN_PIVOT.cx},
      {translateY: -COLUMN_PIVOT.cy},
    ],
  }))

  return (
    <Svg width={width} height={height} viewBox="0 0 174 175" fill="none">
      <Path fill="none" stroke={markColor} strokeWidth={BOWL_STROKE} d={BOWL_D} />
      <AnimatedPath fill="none" stroke={markColor} strokeWidth={BOWL_STROKE} d={BOWL_LID_D} animatedProps={lidProps} />
      <AnimatedPath
        fill="none"
        stroke={markColor}
        strokeMiterlimit={10}
        strokeWidth={SEAT_STROKE}
        d={SEAT_D}
        animatedProps={seatProps}
      />
      <AnimatedG animatedProps={columnsProps}>
        {COLUMNS.map((column) => (
          <Rect key={column.cx} fill={markColor} x={column.x} y={column.y} width={COLUMN_SIZE} height={COLUMN_SIZE} />
        ))}
      </AnimatedG>
    </Svg>
  )
}
