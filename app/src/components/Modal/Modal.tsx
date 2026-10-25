/**
 * Modal component.
 *
 * A versatile modal dialog with bottom-sheet (default) and center positioning,
 * built-in header/footer support, optional scrolling, and smooth animations.
 *
 * **Two-layer architecture, deliberately.** The backdrop Pressable and the
 * content positioner are *siblings*, not ancestor/descendant. Nesting content
 * inside the backdrop Pressable puts gesture-heavy children (ScrollView, pan
 * handlers) inside a Pressable and they compete for the responder on native.
 * `pointerEvents` is likewise passed as a **prop, never a style key** — the
 * style form is ignored on some native-stack / Fabric combinations, which
 * produced the "backdrop not pressable" bug. This shell previously existed
 * twice, and only the copy named `ScrollableModal` carried these fixes.
 *
 * @module
 */

import {memo, type ReactNode, useEffect, useRef} from 'react'
import {
  PanResponder,
  Pressable,
  Modal as RNModal,
  type ModalProps as RNModalProps,
  type StyleProp,
  useWindowDimensions,
  View,
  type ViewStyle,
} from 'react-native'
import {useReanimatedKeyboardAnimation} from 'react-native-keyboard-controller'
import Animated, {useAnimatedStyle, useSharedValue, withSpring, withTiming} from 'react-native-reanimated'
import {StyleSheet, useUnistyles} from 'react-native-unistyles'
import {useLatestRef} from '../../hooks/useLatestRef'
import type {ButtonIconVariant} from '../Buttons'
import {ChamferBackground} from '../Chamfer'
import {DragIndicator} from './DragIndicator'
import {type ModalAction, ModalActions} from './ModalActions'
import {ModalContent} from './ModalContent'
import {ModalHeader} from './ModalHeader'

/** Modal position variant */
export type ModalPosition = 'center' | 'bottom'

/** Animation type for modal appearance */
export type ModalAnimationType = 'fade' | 'slide'

export type ModalProps = Omit<RNModalProps, 'children' | 'animationType'> & {
  /** Modal content */
  children?: ReactNode
  /** Whether the modal is visible */
  visible: boolean
  /** Callback when modal should close */
  onClose: () => void
  /** Whether tapping outside closes the modal */
  dismissable?: boolean | undefined
  /** Modal position */
  position?: ModalPosition | undefined
  /** Animation type (auto-selected based on position if not specified) */
  animationType?: ModalAnimationType | undefined
  /** Modal title */
  title?: string | undefined
  /** Modal description */
  description?: string | undefined
  /** Horizontal alignment of the title/description block (defaults to `left`). */
  headerAlign?: 'left' | 'center' | undefined
  /** Trailing control on the title line — one icon button, e.g. copy-the-link. */
  headerRight?: ReactNode | undefined
  /** Whether to show the back button */
  showBackButton?: boolean | undefined
  /** Back button handler */
  onBack?: (() => void) | undefined
  /** Visual variant for the back button (defaults to `naked`). */
  backButtonVariant?: ButtonIconVariant | undefined
  /** Action buttons for footer */
  actions?: ModalAction[] | undefined
  /** Actions layout direction */
  actionsLayout?: 'horizontal' | 'vertical' | undefined
  /** Test ID for e2e testing */
  testID?: string | undefined
  /** Whether to show the drag indicator */
  showDragIndicator?: boolean | undefined
  /** Override the modal background color */
  backgroundColor?: string | undefined
  /** Override the modal content container padding */
  containerStyle?: StyleProp<ViewStyle> | undefined
  /** Override the modal content container padding */
  contentContainerStyle?: StyleProp<ViewStyle> | undefined
  /** Maximum height of the modal content */
  maxHeight?: number | undefined
  /** Scroll the content area. `ModalContent` implements this; it was unreachable before. */
  scrollable?: boolean | undefined
  /** Override the scrollable content container style */
  modalContentStyle?: StyleProp<ViewStyle> | undefined
}

// Critically damped (damping >= 2 * sqrt(stiffness * mass) ≈ 24.5) plus
// overshootClamping so the bottom sheet glides up to its rest position
// without bouncing past. Bouncing on a content-sized sheet visibly
// changes the sheet's apparent height during settle, which reads as
// "snap" rather than a clean entry.
const SPRING_CONFIG = {damping: 28, stiffness: 300, mass: 0.5, overshootClamping: true}

/**
 * Fallback viewport height for the very first render before
 * `useWindowDimensions` resolves. On extension popups (and occasionally
 * web tabs that mount before layout) `Dimensions.get('window')` — and
 * thus `useWindowDimensions` — returns 0 until the chrome lays the
 * window out. Without a clamp, two reads break:
 *   - `maxHeight: screenHeight * 0.85` → 0 → bottom-sheet collapses
 *   - `useSharedValue(isBottom ? screenHeight : 0)` → 0 → sheet starts
 *     on-screen instead of below it → no slide-up animation
 * 800 is a typical extension popup height; subsequent renders pick up
 * the real dimension within a frame, so this only affects the first
 * render and only on the popup mount-race path.
 */
const FALLBACK_VIEWPORT_HEIGHT = 800

/**
 * Modal component with center and bottom-sheet positioning.
 *
 * @example
 * ```tsx
 * // Centered modal (default)
 * <Modal
 *   visible={showModal}
 *   onClose={handleClose}
 *   title="Confirm Action"
 *   description="Are you sure you want to proceed?"
 *   actions={[
 *     { label: 'Cancel', onPress: handleCancel, variant: 'secondary' },
 *     { label: 'Confirm', onPress: handleConfirm, variant: 'primary' },
 *   ]}
 * >
 *   <CustomContent />
 * </Modal>
 *
 * // Bottom sheet modal
 * <Modal
 *   visible={showSheet}
 *   onClose={handleClose}
 *   position="bottom"
 *   title="Select Option"
 * >
 *   <OptionsList />
 * </Modal>
 * ```
 */
export const Modal = memo(
  ({
    children,
    visible,
    onClose,
    dismissable = true,
    position = 'bottom',
    animationType,
    title,
    description,
    headerAlign,
    headerRight,
    showBackButton = false,
    onBack,
    backButtonVariant,
    actions,
    actionsLayout = 'horizontal',
    testID,
    showDragIndicator = true,
    backgroundColor: backgroundColorProp,
    containerStyle,
    contentContainerStyle,
    maxHeight = 0.85,
    scrollable = false,
    modalContentStyle,
    ...props
  }: ModalProps) => {
    const {theme} = useUnistyles()
    const {height: rawScreenHeight} = useWindowDimensions()
    // Clamp to a non-zero default so the inline `maxHeight` and the
    // animation's initial `translateY` both see a sane value on the
    // very first render before `useWindowDimensions` resolves. See
    // `FALLBACK_VIEWPORT_HEIGHT` doc above.
    const screenHeight = rawScreenHeight > 0 ? rawScreenHeight : FALLBACK_VIEWPORT_HEIGHT
    const isBottom = position === 'bottom'

    // Determine animation type: slide for bottom, fade for center
    const effectiveAnimationType = animationType ?? (isBottom ? 'slide' : 'fade')

    const overlayOpacity = useSharedValue(0)
    const contentTranslateY = useSharedValue(isBottom ? screenHeight : 0)
    const contentOpacity = useSharedValue(effectiveAnimationType === 'fade' ? 0 : 1)
    const contentScale = useSharedValue(effectiveAnimationType === 'fade' ? 0.95 : 1)

    // Keyboard avoidance for bottom sheets. `useReanimatedKeyboardAnimation`
    // returns `height.value` as 0 when the keyboard is hidden and as
    // `-keyboardHeight` while it is visible (library convention), so adding it
    // to the slide/swipe `contentTranslateY` lifts the entire sheet above the
    // keyboard without disturbing the open/close animation. Center modals are
    // already vertically anchored and the OS shifts them as needed, so the
    // offset is gated on `isBottom`.
    const keyboard = useReanimatedKeyboardAnimation()

    useEffect(() => {
      if (visible) {
        // Animate in
        overlayOpacity.value = withTiming(1, {duration: 200})

        if (effectiveAnimationType === 'slide') {
          contentTranslateY.value = withSpring(0, SPRING_CONFIG)
        } else {
          contentOpacity.value = withTiming(1, {duration: 200})
          contentScale.value = withSpring(1, SPRING_CONFIG)
        }
      } else {
        // Animate out
        overlayOpacity.value = withTiming(0, {duration: 150})

        if (effectiveAnimationType === 'slide') {
          contentTranslateY.value = withTiming(screenHeight, {duration: 200})
        } else {
          contentOpacity.value = withTiming(0, {duration: 150})
          contentScale.value = withTiming(0.95, {duration: 150})
        }
      }
    }, [visible, effectiveAnimationType, overlayOpacity, contentTranslateY, contentOpacity, contentScale, screenHeight])

    const overlayAnimatedStyle = useAnimatedStyle(() => ({
      opacity: overlayOpacity.value,
    }))

    const contentAnimatedStyle = useAnimatedStyle(() => {
      // `keyboard.height.value` is 0 when hidden, `-keyboardHeight` when visible
      // (library convention). Used twice:
      //   1. `translateY`: adding it lifts the sheet above the keyboard.
      //   2. `maxHeight`:  adding it shrinks the cap so the lifted sheet's
      //      top can't go off-screen. `Math.min` with the natural 85% cap
      //      means the keyboard branch only takes effect when it's the
      //      tighter constraint — content-sized sheets are unaffected.
      // Height cap is independent of `contentTranslateY` — coupling them
      // would squash the sheet during slide-in (translateY starts at
      // `screenHeight` off-screen) and during swipe-to-dismiss (translateY
      // grows under the user's drag), and could even go negative.
      const rawKeyboard = isBottom ? keyboard.height.value : 0
      // Defensive clamp — `keyboard.height.value` should never report
      // more than the keyboard could plausibly be (≈40% of screen on
      // iPhone). Pathological values (external keyboards, simulator
      // hardware keyboard, library state races) would otherwise lift
      // the sheet far above its natural bottom position. Capping at
      // 60% covers any normal keyboard incl. predictive bar and stops
      // the runaway-offset failure mode that was visible in the Sprint 7
      // recording (sheet floating mid-screen with no visible keyboard).
      const safeKeyboardLimit = -screenHeight * 0.6
      const clampedKeyboard = Math.max(rawKeyboard, safeKeyboardLimit)
      // Ramp the keyboard offset proportionally to entrance progress so
      // the keyboard-up case doesn't snap the sheet mid-animation. At
      // entrance start (contentTranslateY = screenHeight) progress = 0
      // and no offset is applied — the sheet slides cleanly to the
      // natural bottom. At entrance end (contentTranslateY = 0)
      // progress = 1 and the full offset applies, lifting above the
      // keyboard. Same ramp covers swipe-to-dismiss in reverse.
      const entranceProgress = 1 - Math.min(Math.max(contentTranslateY.value / screenHeight, 0), 1)
      const keyboardOffset = clampedKeyboard * entranceProgress
      const naturalMax = screenHeight * maxHeight
      const availableHeight = screenHeight * 0.9 + keyboardOffset
      return {
        transform: [{translateY: contentTranslateY.value + keyboardOffset}, {scale: contentScale.value}],
        opacity: contentOpacity.value,
        maxHeight: isBottom ? Math.min(naturalMax, availableHeight) : undefined,
      }
    })

    // Swipe-to-dismiss for bottom sheets.
    //
    // The PanResponder is created once (useRef) to avoid re-creating gesture
    // handlers on every render. This is safe because:
    // - onClose, dismissable, isBottom are accessed via refs that stay in sync
    // - contentTranslateY is a Reanimated SharedValue (mutable .value), so the
    //   reference captured at creation time always reflects current state
    // - DISMISS_THRESHOLD is a constant
    const DISMISS_THRESHOLD = 80
    const onCloseRef = useLatestRef(onClose)
    const dismissableRef = useLatestRef(dismissable)
    const isBottomRef = useLatestRef(isBottom)
    const panResponder = useRef(
      PanResponder.create({
        onStartShouldSetPanResponder: () => isBottomRef.current && dismissableRef.current !== false,
        onMoveShouldSetPanResponder: (_evt, gestureState) =>
          isBottomRef.current && dismissableRef.current !== false && gestureState.dy > 10,
        onPanResponderMove: (_evt, gestureState) => {
          if (gestureState.dy > 0) {
            contentTranslateY.value = gestureState.dy
          }
        },
        onPanResponderRelease: (_evt, gestureState) => {
          if (gestureState.dy > DISMISS_THRESHOLD) {
            onCloseRef.current()
          } else {
            contentTranslateY.value = withSpring(0, SPRING_CONFIG)
          }
        },
      }),
    ).current

    const hasHeader = title || description || showBackButton || headerRight
    const hasActions = actions && actions.length > 0

    return (
      <RNModal
        visible={visible}
        transparent
        animationType="none"
        statusBarTranslucent
        onRequestClose={onClose}
        testID={testID}
        {...props}
      >
        {/* Two-layer architecture: backdrop Pressable and content positioner are siblings.
            Content is never inside the backdrop Pressable, so gesture-heavy children do not
            compete for the responder on native. See the module doc. */}
        <View style={styles.root}>
          <Pressable
            style={styles.backdropFill}
            onPress={dismissable ? onClose : undefined}
            disabled={!dismissable}
            testID="modal-backdrop"
          >
            {/* `pointerEvents` as a PROP, not a style key — see the module doc. */}
            <Animated.View pointerEvents="none" style={[styles.overlayFill, overlayAnimatedStyle]} />
          </Pressable>

          <View
            pointerEvents="box-none"
            style={[styles.contentPositioner, isBottom ? styles.contentBottom : styles.contentCenter]}
          >
            <Animated.View
              style={[styles.content(), isBottom ? styles.contentSheetStyle : undefined, contentAnimatedStyle]}
            >
              <ChamferBackground
                size="auto"
                cut={isBottom ? 'top' : 'diagonal'}
                fill={backgroundColorProp ?? theme.colors.backgroundDefault}
                {...(isBottom ? {borderColor: theme.colors.borderInteractive, borderWidth: 1} : {})}
              />
              <View
                style={[styles.innerContainer(!!hasHeader), isBottom && styles.innerContainerSheet, containerStyle]}
              >
                {hasHeader && (
                  <View {...(isBottom ? panResponder.panHandlers : {})} style={styles.headerContainer}>
                    <ModalHeader
                      title={title}
                      description={description}
                      onClose={onClose}
                      dismissable={dismissable}
                      showBackButton={showBackButton}
                      onBack={onBack}
                      backButtonVariant={backButtonVariant}
                      showDragIndicator={isBottom && showDragIndicator}
                      align={headerAlign}
                      headerRight={headerRight}
                    />
                  </View>
                )}
                <View style={[styles.contentContainer, contentContainerStyle]}>
                  {!hasHeader && isBottom && (
                    <DragIndicator panHandlers={panResponder.panHandlers} onPress={dismissable ? onClose : undefined} />
                  )}

                  <ModalContent scrollable={scrollable} style={modalContentStyle}>
                    {children}
                  </ModalContent>

                  {hasActions && <ModalActions actions={actions} layout={actionsLayout} />}
                </View>
              </View>
            </Animated.View>
          </View>
        </View>
      </RNModal>
    )
  },
)

// Re-export subcomponents for composition
export {type ModalAction, ModalActions} from './ModalActions'
export {ModalContent, type ModalContentProps} from './ModalContent'
export {ModalHeader, type ModalHeaderProps} from './ModalHeader'

const styles = StyleSheet.create(({spacing}, rt) => ({
  // Full-screen pressable backdrop — handles dismiss on tap
  root: {
    flex: 1,
  },
  // Explicit absolute fill: `StyleSheet.absoluteFillObject` is `undefined` on the
  // unistyles Nitro StyleSheet, so spreading it contributes nothing and the sheet
  // collapses to the top of the screen.
  backdropFill: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  // Dark overlay — purely visual, covers full screen.
  // Explicit absolute fill: `StyleSheet.absoluteFillObject` is `undefined` on
  // the unistyles Nitro StyleSheet, so spreading it would contribute nothing
  // — the overlay wouldn't cover and the positioner would collapse to its
  // content at the top of the screen.
  overlayFill: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
  },
  // Content positioner — absolutely positioned, passes clicks through to backdrop
  contentPositioner: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  contentCenter: {
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    padding: spacing.spacing16,
  },
  contentBottom: {
    justifyContent: 'flex-end' as const,
    alignItems: 'center' as const,
  },
  // The surface is painted onto the chamfer, so the box itself stays transparent.
  content: () => ({
    width: '100%' as const,
  }),
  contentSheetStyle: {
    maxWidth: '100%' as const,
  },
  // `flexShrink: 1` here and on `contentContainer` is load-bearing, and it is the
  // whole chain: the sheet's `maxHeight` lands on the animated wrapper, and Yoga
  // defaults `flexShrink` to 0 (not 1 as CSS does), so every View between that
  // clamp and the ScrollView must opt in or it takes its content height and the
  // ScrollView never receives a bounded box to scroll inside. `headerContainer`
  // keeps the default so the title holds its size while the content area gives way.
  innerContainer: (hasHeader: boolean) => ({
    paddingTop: hasHeader ? 0 : spacing.spacing16,
    paddingBottom: spacing.spacing16,
    flexShrink: 1,
  }),
  contentContainer: {
    paddingHorizontal: spacing.spacing16,
    flexShrink: 1,
  },
  innerContainerSheet: {
    paddingBottom: Math.max(spacing.spacing32, rt.insets.bottom + spacing.spacing16),
  },
  headerContainer: {
    zIndex: 2,
  },
}))
