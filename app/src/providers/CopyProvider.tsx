/**
 * Clipboard context provider with visual feedback.
 *
 * Provides copy functionality with animated toast notifications
 * positioned near the touch location.
 *
 * @module
 */

import * as Clipboard from 'expo-clipboard'
import * as React from 'react'
import {type GestureResponderEvent, Text, useWindowDimensions} from 'react-native'
import Animated, {FadeInDown, FadeOutDown, FadingTransition} from 'react-native-reanimated'
import {StyleSheet} from 'react-native-unistyles'

import {ChamferBackground} from '../components/Chamfer'
import {osShowsClipboardToast} from '../platform'

type CopyProps = {
  /** Text to copy to clipboard */
  text: string
  /** Optional feedback message (default: "Copied") */
  feedback?: string
  /** Touch event for positioning the feedback toast */
  event?: GestureResponderEvent
}

type CopyContextValue = {
  /** Copy text to clipboard with visual feedback */
  copy: (props: CopyProps) => Promise<void>
  /** The text that was most recently copied (null when idle) */
  copiedText: string | null
}

const CopyContext = React.createContext<CopyContextValue | undefined>(undefined)

type CopiedState = {
  feedback: string
  locationX: number
  locationY: number
}

const FEEDBACK_TIMEOUT_MS = 1500

/**
 * Animated feedback toast shown after copying.
 */
const CopyFeedback = React.memo(({copied}: {copied: CopiedState}) => {
  return (
    <Animated.View
      layout={FadingTransition}
      entering={FadeInDown}
      exiting={FadeOutDown}
      style={[styles.feedback, {top: copied.locationY, left: copied.locationX}]}
    >
      <ChamferBackground size="auto" fillToken="backgroundAlternative" />
      <Text style={styles.feedbackText}>{copied.feedback}</Text>
    </Animated.View>
  )
})

/**
 * Provider component for clipboard functionality.
 *
 * Wrap your app with this provider to enable the `useCopy` hook.
 *
 * @example
 * ```tsx
 * <CopyProvider>
 *   <App />
 * </CopyProvider>
 * ```
 */
export const CopyProvider = React.memo(({children}: React.PropsWithChildren) => {
  const {height, width} = useWindowDimensions()
  const [copied, setCopied] = React.useState<CopiedState | null>(null)
  const [copiedText, setCopiedText] = React.useState<string | null>(null)
  const timeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  const copy = React.useCallback(
    async ({text, feedback = 'Copied', event}: CopyProps) => {
      // Persist event data before async operation
      const eventData = event
        ? {
            pageX: event.nativeEvent.pageX,
            pageY: event.nativeEvent.pageY,
          }
        : null

      // Calculate X position, keeping toast within screen bounds
      const baseLocationX = (eventData?.pageX ?? width * 0.5) - feedback.length * 4
      const maxX = width - 20 - feedback.length * 8
      const minX = 20 + feedback.length * 8
      const locationX = Math.min(Math.max(baseLocationX, minX), maxX)

      // Calculate Y position (50px above touch or near bottom if no event)
      const locationY = eventData ? eventData.pageY - 50 : height * 0.85

      await Clipboard.setStringAsync(text)
      setCopied({feedback, locationY, locationX})
      setCopiedText(text)

      if (timeoutRef.current !== null) clearTimeout(timeoutRef.current)
      timeoutRef.current = setTimeout(() => {
        setCopied(null)
        setCopiedText(null)
        timeoutRef.current = null
      }, FEEDBACK_TIMEOUT_MS)
    },
    [height, width],
  )

  const value = React.useMemo(
    () => ({
      copy,
      copiedText,
    }),
    [copy, copiedText],
  )

  return (
    <CopyContext.Provider value={value}>
      {children}
      {copied && !osShowsClipboardToast && <CopyFeedback copied={copied} />}
    </CopyContext.Provider>
  )
})

/**
 * Hook to access clipboard copy functionality.
 *
 * @throws Error if used outside of CopyProvider
 *
 * @example
 * ```tsx
 * const { copy, copiedText } = useCopy()
 *
 * const handleCopy = () => {
 *   copy({ text: 'Hello World', feedback: 'Address copied!' })
 * }
 * ```
 */
export const useCopy = (): CopyContextValue => {
  const context = React.useContext(CopyContext)
  if (!context) {
    throw new Error('useCopy must be used within a CopyProvider')
  }
  return context
}

const styles = StyleSheet.create((theme) => ({
  feedback: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10,
  },
  feedbackText: {
    textAlign: 'center',
    padding: theme.spacing.spacing12,
    fontSize: theme.fontSizes.bodyMd,
    fontFamily: theme.fontFamily.medium,
    color: theme.colors.textDefault,
  },
}))
