/**
 * Whether a message list is close enough to its end to keep following it.
 *
 * A conversation reads bottom-up: the last thing said is the thing you opened it
 * for, so these lists start at the end rather than at the beginning. Staying there
 * is the part that needs a rule, because "always scroll to the end when the content
 * grows" is wrong in the one case that matters — someone reading back through
 * history gets yanked to the bottom by a message arriving on the 5s poll.
 *
 * So: follow while the reader is already at the end, and stop the moment they
 * scroll away from it. The threshold exists because "at the end" is never exact —
 * a bounce, a rounding error in the content height, or a keyboard resizing the
 * viewport all leave a few pixels behind, and requiring zero would silently turn
 * following off.
 *
 * Pure, and separate from the hook, so the rule can be tested without a renderer.
 *
 * @module
 */

/** How far from the end still counts as "at the end", in points. About one line of text. */
export const STICK_THRESHOLD = 80

export type ScrollGeometry = {
  /** How far the content has been scrolled — `contentOffset.y`. */
  readonly offsetY: number
  /** The full height of the content — `contentSize.height`. */
  readonly contentHeight: number
  /** The visible height — `layoutMeasurement.height`. */
  readonly viewportHeight: number
}

/**
 * True while the list should keep jumping to the end as content arrives.
 *
 * Content shorter than the viewport has no scroll and therefore no "away from the
 * end" to be in — it stays true, or the first message in an empty thread would
 * turn following off before it ever started.
 */
export const isAtBottom = (geometry: ScrollGeometry, threshold = STICK_THRESHOLD): boolean => {
  const remaining = geometry.contentHeight - geometry.viewportHeight - geometry.offsetY
  return remaining <= threshold
}
