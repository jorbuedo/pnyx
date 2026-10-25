/**
 * Travel geometry for the indeterminate progress line.
 *
 * Separated from the component so the arithmetic can be tested without a renderer, and so the
 * animated style stays a one-liner — these run on the UI thread inside a worklet, where a mistake
 * shows up as a bar parked off-screen rather than as an error.
 *
 * @module
 */

/** One full crossing, in ms. */
export const TRAVEL_MS = 1150

/** Fraction of the track the moving segment occupies. */
export const SEGMENT_RATIO = 0.35

/** The segment's width for a track of `trackWidth`. */
export const segmentWidth = (trackWidth: number): number => {
  'worklet'
  return trackWidth * SEGMENT_RATIO
}

/**
 * Where the segment sits at `progress` (0 → 1), in px from the track's left edge.
 *
 * Starts fully off the left edge and ends fully off the right, so the loop reads as continuous
 * travel rather than a bar that pops into existence at x=0. That is why the span is
 * `track + segment` and not `track`.
 */
export const segmentOffset = (trackWidth: number, progress: number): number => {
  'worklet'
  const segment = trackWidth * SEGMENT_RATIO
  return -segment + progress * (trackWidth + segment)
}
