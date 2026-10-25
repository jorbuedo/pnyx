import {type ReactNode, useState} from 'react'
import {type LayoutChangeEvent, ScrollView, type ScrollViewProps, View, type ViewStyle} from 'react-native'
import {KeyboardStickyView, useReanimatedKeyboardAnimation} from 'react-native-keyboard-controller'
import Animated, {useAnimatedStyle} from 'react-native-reanimated'
import {StyleSheet} from 'react-native-unistyles'
import {ProgressLine} from './Loaders/ProgressLine'
import {BlobBackground} from './patterns/BlobBackground'

/** First-frame reserved space for a sticky footer before its real height is
 *  measured — covers a typical single-button footer so content never starts
 *  underneath it (the measurement refines this once `onLayout` fires). */
const STICKY_FOOTER_ESTIMATE = 96

/** Must match `KeyboardStickyView`'s `offset.opened` below, or content clears the
 *  keyboard but not the raised footer. */
const KEYBOARD_FOOTER_GAP = 12

/**
 * SafeAreaView wrapper that handles safe-area insets and wraps content in
 * the app's `BlobBackground`.
 *
 * When `stickyFooter` is provided, it is rendered inside a glass-effect
 * footer pinned to the bottom. The footer height is measured via `onLayout`
 * and automatically applied as `paddingBottom` on the content — screens do
 * not need to pass `defaultBottomPadding` to compensate for the footer.
 *
 * When `scrollable` is true, children are wrapped in a `ScrollView`.
 * The `stickyFooter` stays outside the scroll area so it remains pinned.
 *
 * `contentAvoidsKeyboard` is what chat-shaped screens need: the sticky footer
 * already rides up on the keyboard, but the *content* keeps its resting height,
 * so whatever sat at the bottom of the list ends up behind the keyboard. Opt in
 * and the content shrinks by the keyboard height too. Off by default because
 * several screens (`onboarding/restore`, `settings/backup-verification`) pair a
 * sticky footer with their own `KeyboardAvoidingView` / `KeyboardAwareScrollView`
 * and would then compensate twice.
 */
export function SafeAreaViewWrapper({
  children,
  edges,
  style,
  hasBottomMenu = false,
  scrollable = false,
  progress = false,
  stickyFooter,
  stickyFooterTracksKeyboard = true,
  contentAvoidsKeyboard = false,
  reserveStickyFooterSpace = true,
  defaultTopPadding = 16,
  defaultBottomPadding = 16,
  noPadding = false,
  ref,
  contentContainerStyle,
  ...scrollViewProps
}: {
  children: ReactNode
  edges?: ('top' | 'bottom')[]
  /** Applied to the outermost BlobBackground container. */
  style?: ViewStyle
  /** When true, suppresses adding `rt.insets.bottom` — use on screens where the tab bar already owns the bottom inset. */
  hasBottomMenu?: boolean
  /** When true, wraps children in a ScrollView. */
  scrollable?: boolean
  /**
   * Show the indeterminate progress line at the top of the content.
   *
   * For any fetch the user did not explicitly pull for — cold boot, a wallet or network switch, a
   * refetch on focus. It overlays rather than occupies, so turning it on mid-render moves nothing
   * and blocks nothing.
   */
  progress?: boolean
  /** Content rendered inside a glass-effect footer pinned to the bottom. */
  stickyFooter?: ReactNode
  /** When false, the footer stays pinned at the bottom and the keyboard covers it instead of pushing it up. */
  stickyFooterTracksKeyboard?: boolean
  /** Shrink the content area by the keyboard height so a bottom-anchored list is not hidden behind it. */
  contentAvoidsKeyboard?: boolean
  reserveStickyFooterSpace?: boolean
  defaultTopPadding?: number
  /** Extra bottom padding when no stickyFooter is present. Ignored when stickyFooter is provided — the measured footer height is used instead. */
  defaultBottomPadding?: number
  /** When true, sets both top and bottom padding to 0 regardless of `defaultTopPadding`/`defaultBottomPadding`. */
  noPadding?: boolean
  ref?: React.RefObject<ScrollView | null>
} & ScrollViewProps) {
  // Measured height of the absolutely-positioned sticky footer, used as the
  // content's paddingBottom so the footer never obscures it. Seed with a
  // realistic estimate (not just `defaultBottomPadding`) so the FIRST frame
  // already reserves room — release builds don't always fire the footer's
  // `onLayout` on initial mount, and a 16px seed left content sliding under the
  // footer until the screen was re-mounted. The real measurement refines this.
  const [footerHeight, setFooterHeight] = useState(stickyFooter != null ? STICKY_FOOTER_ESTIMATE : 0)

  // When stickyFooter is provided, exclude 'bottom' from safe-area edges
  // so the footer can extend through the bottom inset with its own padding.
  const resolvedEdges: ('top' | 'bottom')[] | undefined = stickyFooter != null ? excludeBottomEdge(edges) : edges

  const computedBottomPadding =
    stickyFooter != null && reserveStickyFooterSpace ? footerHeight : noPadding ? 0 : defaultBottomPadding

  const body = scrollable ? (
    <ScrollView
      contentContainerStyle={[
        styles.container({
          top: resolvedEdges?.includes('top') ?? false,
          bottom: resolvedEdges?.includes('bottom') ?? false,
          defaultTopPadding: noPadding ? 0 : defaultTopPadding,
          defaultBottomPadding: computedBottomPadding,
          hasBottomMenu,
        }),
        styles.flexGrow,
        contentContainerStyle,
      ]}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
      scrollEventThrottle={64}
      ref={ref}
      {...scrollViewProps}
    >
      {children}
    </ScrollView>
  ) : (
    <View
      style={[
        styles.container({
          top: resolvedEdges?.includes('top') ?? false,
          bottom: resolvedEdges?.includes('bottom') ?? false,
          defaultTopPadding: noPadding ? 0 : defaultTopPadding,
          defaultBottomPadding: computedBottomPadding,
          hasBottomMenu,
        }),
        styles.flex,
        contentContainerStyle,
      ]}
    >
      {children}
    </View>
  )

  const onFooterLayout = (e: LayoutChangeEvent) => setFooterHeight(e.nativeEvent.layout.height)

  // `height.value` is 0 while the keyboard is hidden and `-keyboardHeight` while it
  // is shown (library convention, same as Modal.tsx), so negating it gives the space
  // to reclaim. Driven on the UI thread — a JS-side keyboard listener setting state
  // would land a frame or two after the keyboard has already moved.
  const {height: keyboardHeight, progress: keyboardProgress} = useReanimatedKeyboardAnimation()
  const keyboardSpacing = useAnimatedStyle(() =>
    contentAvoidsKeyboard
      ? {paddingBottom: -keyboardHeight.value + KEYBOARD_FOOTER_GAP * keyboardProgress.value}
      : {paddingBottom: 0},
  )

  const avoidingBody = contentAvoidsKeyboard ? (
    <Animated.View style={[styles.flex, keyboardSpacing]}>{body}</Animated.View>
  ) : (
    body
  )

  const safeAreaContent = (
    <>
      {avoidingBody}
      {/* Pinned to the top of the content the way `stickyFooter` is pinned to the bottom, so it
          sits under the navigator header and scrolls with nothing. Last in source for the same
          reason the footer is: an absolute sibling paints over its predecessors on every platform,
          which `zIndex` alone is not dependable enough to guarantee on Android. */}
      <ProgressLine show={progress} />
      {stickyFooter != null &&
        (stickyFooterTracksKeyboard ? (
          // Measure on the inner plain View, not on KeyboardStickyView — the
          // Reanimated wrapper doesn't reliably fire `onLayout` on first mount
          // in release builds, which left the content's reserved space stuck at
          // the initial estimate until the screen was re-mounted.
          <KeyboardStickyView offset={{closed: 0, opened: 12}} style={styles.stickyFooter}>
            <View onLayout={onFooterLayout}>{stickyFooter}</View>
          </KeyboardStickyView>
        ) : (
          <View style={styles.stickyFooter} onLayout={onFooterLayout}>
            {stickyFooter}
          </View>
        ))}
    </>
  )

  return <BlobBackground style={[styles.flex, style]}>{safeAreaContent}</BlobBackground>
}

/**
 * Removes 'bottom' from the edges config so the StickyFooter can handle
 * the bottom inset itself.
 */
function excludeBottomEdge(edges: ('top' | 'bottom')[] | undefined): ('top' | 'bottom')[] {
  if (edges == null) return ['top', 'bottom']
  return edges.filter((e) => e !== 'bottom')
}

const styles = StyleSheet.create((_t, rt) => ({
  container: ({
    top,
    bottom,
    defaultTopPadding,
    defaultBottomPadding,
    hasBottomMenu,
  }: {
    top: boolean
    bottom: boolean
    defaultTopPadding: number
    defaultBottomPadding: number
    hasBottomMenu: boolean
  }) => {
    return {
      paddingTop: top ? rt.insets.top + defaultTopPadding : defaultTopPadding,
      paddingBottom: hasBottomMenu
        ? defaultBottomPadding
        : bottom
          ? rt.insets.bottom + defaultBottomPadding
          : defaultBottomPadding,
    }
  },
  flexGrow: {
    flexGrow: 1,
  },
  flex: {
    flex: 1,
  },
  stickyFooter: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
  },
}))
