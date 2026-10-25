/**
 * Dev mode toggle component.
 *
 * Provides a hidden 5-tap gesture to enable/disable developer mode.
 * When enabled, sets the 'devTools' feature flag runtime override.
 *
 * This component should be added as a transparent overlay on the About screen
 * to gate developer tooling behind a deliberate gesture.
 *
 * @module
 */

import type {FeatureFlagsService} from '@pnyx/config'
import {Effect} from 'effect'
import Constants from 'expo-constants'
import {useCallback, useEffect, useRef} from 'react'
import {Pressable, StyleSheet} from 'react-native'

import {useToast} from '../hooks/useToast'
import {logger} from '../logger'
import {useI18n} from '../providers'
import {useConfig} from '../providers/ConfigProvider'

type TFn = ReturnType<typeof useI18n>['t']
type ShowToast = ReturnType<typeof useToast>['showToast']

/**
 * Time window for counting taps (ms).
 */
const TAP_WINDOW_MS = 2000

/**
 * Number of taps required to toggle dev mode.
 */
const REQUIRED_TAPS = 5

/**
 * Props for DevModeToggle.
 */
export type DevModeToggleProps = {
  /** Optional test ID */
  testID?: string
}

/**
 * Toggle dev mode with given service.
 */
const toggleDevMode = async (service: FeatureFlagsService, t: TFn, showToast: ShowToast): Promise<void> => {
  // Get current state
  const currentState = await Effect.runPromise(service.isEnabled('devTools'))

  // Toggle
  const newState = !currentState
  await Effect.runPromise(service.setRuntimeOverride('devTools', newState))

  showToast({
    variant: newState ? 'success' : 'neutral',
    message: newState ? t('settings.developer.devModeEnabledTitle') : t('settings.developer.devModeDisabledTitle'),
  })
}

/**
 * Dev mode toggle component.
 *
 * Renders a transparent overlay that counts taps within a time window.
 * After 5 taps within 2 seconds, toggles the devTools feature flag.
 *
 * @example
 * ```tsx
 * <View>
 *   <Text>About Screen</Text>
 *   <DevModeToggle />
 * </View>
 * ```
 */
export function DevModeToggle({testID = 'dev-mode-toggle'}: DevModeToggleProps) {
  const isProdEnv = Constants.expoConfig?.extra?.appEnv === 'prod'
  const {featureFlagsService, isFeatureFlagsLoading} = useConfig()
  const {t} = useI18n()
  const {showToast} = useToast()
  const tapCountRef = useRef(0)
  const firstTapTimeRef = useRef<number | null>(null)
  const timeoutRef = useRef<NodeJS.Timeout | null>(null)

  const handlePress = useCallback(() => {
    // Don't process taps if service not loaded
    if (isFeatureFlagsLoading || !featureFlagsService) {
      return
    }

    const now = Date.now()

    // Reset if this is the first tap or window expired
    if (firstTapTimeRef.current === null || now - firstTapTimeRef.current > TAP_WINDOW_MS) {
      tapCountRef.current = 1
      firstTapTimeRef.current = now

      // Clear any existing timeout
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
      }

      // Set timeout to reset after window
      timeoutRef.current = setTimeout(() => {
        tapCountRef.current = 0
        firstTapTimeRef.current = null
      }, TAP_WINDOW_MS) as unknown as NodeJS.Timeout

      return
    }

    // Increment tap count
    tapCountRef.current += 1

    // Check if we've reached the required taps
    if (tapCountRef.current >= REQUIRED_TAPS) {
      // Clear timeout
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current as unknown as number)
        timeoutRef.current = null
      }

      // Reset counters
      tapCountRef.current = 0
      firstTapTimeRef.current = null

      // Toggle dev mode
      toggleDevMode(featureFlagsService, t, showToast).catch((error) => {
        logger.error('Failed to toggle dev mode', {origin: 'DevModeToggle', cause: error})
        showToast({variant: 'error', message: t('settings.developer.devModeToggleErrorMessage')})
      })
    }
  }, [featureFlagsService, isFeatureFlagsLoading, t, showToast])

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current as unknown as number)
      }
    }
  }, [])

  // Dev mode is unreachable in the production environment — never mount the tap
  // overlay. Preview builds (appEnv='preview', buildVariant='prod') keep it.
  if (isProdEnv) {
    return null
  }

  return (
    <Pressable
      style={styles.overlay}
      onPress={handlePress}
      testID={testID}
      accessible={false}
      accessibilityElementsHidden
    />
  )
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'transparent',
  },
})
