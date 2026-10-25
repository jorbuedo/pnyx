/**
 * Shrink a single-line hero number to fit its measured container width.
 *
 * `adjustsFontSizeToFit` is the RN-native answer but it's a no-op on
 * react-native-web (extension + web) and inconsistent on Android. This hook
 * measures the available width via `onLayout` and computes a font size that
 * fits, deterministically and identically on every platform.
 *
 * Width is estimated as `chars × widthRatio × fontSize`; we solve for the
 * largest `fontSize ≤ maxFontSize` that keeps the string within the budget,
 * clamped to `minFontSize`. The estimate is intentionally conservative — a
 * slightly-too-small size never clips, a slightly-too-large one does.
 *
 * @module
 */

import {useCallback, useEffect, useRef, useState} from 'react'
import type {LayoutChangeEvent} from 'react-native'

/** Quiet window after the last layout event before a measured width is applied. */
const LAYOUT_SETTLE_MS = 120

export type ComputeFitFontSizeParams = {
  /** Character count of the string that will render. */
  readonly chars: number
  /** Measured width of the row, or null before the first layout pass. */
  readonly availableWidth: number | null
  /** Font size used when there is room / before measurement. */
  readonly maxFontSize: number
  /** Smallest size we shrink to. */
  readonly minFontSize: number
  /** Average glyph advance as a fraction of font size (bold display ≈ 0.6em). */
  readonly widthRatio: number
  /** Px reserved on the row for sibling content (privacy eye + gap). */
  readonly reserveWidth: number
}

/**
 * Pure font-size solver behind {@link useFitFontSize}. Extracted so the fit
 * math can be unit-tested without a render.
 */
export function computeFitFontSize({
  chars,
  availableWidth,
  maxFontSize,
  minFontSize,
  widthRatio,
  reserveWidth,
}: ComputeFitFontSizeParams): number {
  if (availableWidth == null) return maxFontSize
  const budget = Math.max(availableWidth - reserveWidth, 0)
  const fit = Math.floor(budget / (Math.max(chars, 1) * widthRatio))
  return Math.max(minFontSize, Math.min(maxFontSize, fit))
}

export type UseFitFontSizeParams = {
  /** The exact string that will render (symbol + grouped digits). */
  readonly text: string
  /** Font size used when there is room / before the first layout pass. */
  readonly maxFontSize: number
  /** Smallest size we shrink to. */
  readonly minFontSize: number
  /**
   * Average glyph advance as a fraction of the font size. Bold display digits
   * + separators average ~0.6em; tune per font weight.
   */
  readonly widthRatio?: number
  /** Px reserved on the measured row for sibling content (privacy eye + gap). */
  readonly reserveWidth?: number
}

export type FitFontSizeResult = {
  readonly fontSize: number
  readonly onLayout: (event: LayoutChangeEvent) => void
}

export function useFitFontSize({
  text,
  maxFontSize,
  minFontSize,
  widthRatio = 0.6,
  reserveWidth = 0,
}: UseFitFontSizeParams): FitFontSizeResult {
  const [rowWidth, setRowWidth] = useState<number | null>(null)
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingWidth = useRef<number | null>(null)

  // Apply only the width that holds once layout goes quiet. On mount a row
  // reports a burst of partial widths before settling; sizing against each
  // would flicker the font down and back up. Debouncing collapses that burst
  // to the settled width — and still re-runs on a genuine container shrink
  // (window resize / tablet split-view), so the font narrows with it. A
  // max-only approach would never shrink, truncating text after a resize.
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    pendingWidth.current = event.nativeEvent.layout.width
    if (settleTimer.current != null) clearTimeout(settleTimer.current)
    settleTimer.current = setTimeout(() => {
      settleTimer.current = null
      setRowWidth(pendingWidth.current)
    }, LAYOUT_SETTLE_MS)
  }, [])

  useEffect(
    () => () => {
      if (settleTimer.current != null) clearTimeout(settleTimer.current)
    },
    [],
  )

  const fontSize = computeFitFontSize({
    chars: text.length,
    availableWidth: rowWidth,
    maxFontSize,
    minFontSize,
    widthRatio,
    reserveWidth,
  })

  return {fontSize, onLayout}
}
