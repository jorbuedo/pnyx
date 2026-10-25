/**
 * Privacy placeholder generator — pure module, no React/RN deps.
 *
 * Masked values are rendered as bullet (`•`) characters, length-matched to the visible
 * character count of the original (whitespace stripped) and clamped to
 * `[MIN_DOTS, MAX_DOTS]`. So `2%` becomes `••••` (min) and `$12,847.50`
 * becomes `••••••••` (max), keeping the visual rhythm without leaking
 * exact lengths.
 *
 * @module
 */

/** Bullet character used for the masked placeholder. */
export const DOT_CHAR = '•'

/** Minimum number of dots in the placeholder, regardless of input length. */
export const MIN_DOTS = 4

/** Maximum number of dots in the placeholder, regardless of input length. */
export const MAX_DOTS = 8

/**
 * Build a length-matched dot placeholder from `original`. Whitespace is
 * stripped before counting; the result is clamped to `[MIN_DOTS, MAX_DOTS]`.
 * If `original` is undefined, empty, or whitespace-only, returns `MIN_DOTS`
 * dots.
 */
export const dotsFor = (original?: string): string => {
  const visibleCount = (original ?? '').replace(/\s+/g, '').length || MIN_DOTS
  const n = Math.min(Math.max(visibleCount, MIN_DOTS), MAX_DOTS)
  return DOT_CHAR.repeat(n)
}
