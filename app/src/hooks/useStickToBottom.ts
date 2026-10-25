/**
 * Open a message list at the latest message, and keep it there while it is read.
 *
 * Shared by every conversation surface — DM threads, the offline notes, circle
 * channels — because a list that starts at the oldest message is the same defect
 * on all three, and one that scrolled differently per screen would be a second
 * answer to one question. Works on both `ScrollView` and `FlatList`: the only
 * thing it needs from either is `scrollToEnd`.
 *
 * The rule it follows lives in {@link isAtBottom}; this is the wiring. Two details
 * worth knowing:
 *
 * - **It starts as "at the bottom"**, so the first `onContentSizeChange` — the one
 *   that fires when the thread's messages are first laid out — jumps to the end.
 *   Starting as `false` would open every thread at the oldest message, which is
 *   the thing being fixed.
 * - **A ref, not state.** The follow flag changes on every scroll frame; as state
 *   it would re-render the whole list while the user drags it.
 *
 * Not virtualization. A very long thread still renders every row, and the jump is
 * to the end of what has been measured — see `docs/LINK_ACTIONS_HANDOFF.md` for
 * where that is tracked.
 *
 * @module
 */

import {useCallback, useRef} from 'react'
import type {NativeScrollEvent, NativeSyntheticEvent} from 'react-native'
import {isAtBottom} from './stick-to-bottom'

/** The part of `ScrollView` / `FlatList` this needs. Neither type is imported, so both fit. */
type ScrollsToEnd = {scrollToEnd: (options?: {animated?: boolean}) => void}

/**
 * Props to spread onto the list.
 *
 * `useStickToBottom<ScrollView>()` / `useStickToBottom<FlatList<T>>()` — the type
 * argument is what makes `ref` land on either component without a cast.
 */
export const useStickToBottom = <T extends ScrollsToEnd>() => {
  const ref = useRef<T>(null)
  const following = useRef(true)

  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const {contentOffset, contentSize, layoutMeasurement} = event.nativeEvent
    following.current = isAtBottom({
      offsetY: contentOffset.y,
      contentHeight: contentSize.height,
      viewportHeight: layoutMeasurement.height,
    })
  }, [])

  const onContentSizeChange = useCallback(() => {
    // Unanimated on purpose: this fires on mount, and an animated scroll there is a
    // visible ride from the top of the thread to the bottom every time it opens.
    if (following.current) ref.current?.scrollToEnd({animated: false})
  }, [])

  return {ref, onScroll, onContentSizeChange, scrollEventThrottle: 16} as const
}
