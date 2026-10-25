/**
 * Privacy mode context and hook for masking sensitive data.
 *
 * Uses a React context so all consumers share the same state.
 * Wrap the app with `<PrivacyProvider>` and consume via `usePrivacyMode()`.
 *
 * Masked values are rendered as bullet (`•`) characters, length-matched to the visible
 * character count of the original (whitespace stripped) and clamped to
 * `[MIN_DOTS, MAX_DOTS]`. So `2%` becomes `••••` (min) and `$12,847.50`
 * becomes `••••••••` (max), keeping the visual rhythm without leaking
 * exact lengths.
 *
 * @module
 */

import {
  createContext,
  createElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'
import {logger} from '../logger'
import {storage} from '../platform/storage'
import {dotsFor} from './privacy-placeholder'

const PRIVACY_MODE_KEY = '@pnyx/privacy_mode_enabled'

export type PrivacyMode = {
  /** Whether privacy mode is currently enabled */
  isEnabled: boolean
  /** Toggle privacy mode on/off */
  toggle: () => void
  /** Set privacy mode directly */
  setEnabled: (enabled: boolean) => void
  /**
   * Build the dot placeholder. Pass the original string to length-match
   * the dot count (clamped to `[4, 8]`); omit it for the default 4-dot
   * placeholder.
   */
  getPlaceholder: (original?: string) => string
  /**
   * Helper to mask a value when privacy mode is enabled. Returns the
   * length-matched placeholder for string inputs and a default-length
   * placeholder for everything else.
   */
  mask: <T>(value: T) => T | string
}

const defaultValue: PrivacyMode = {
  isEnabled: false,
  toggle: () => {},
  setEnabled: () => {},
  getPlaceholder: dotsFor,
  mask: <T>(value: T) => value,
}

export const PrivacyContext = createContext<PrivacyMode>(defaultValue)

export const PrivacyProvider = ({children}: {children: ReactNode}) => {
  const [isEnabled, setIsEnabledState] = useState(false)
  const [isLoaded, setIsLoaded] = useState(false)

  // Load saved preference on mount
  useEffect(() => {
    const loadPreference = async () => {
      try {
        const stored = await storage.get(PRIVACY_MODE_KEY)
        if (stored !== null) {
          setIsEnabledState(stored === 'true')
        }
      } catch (e: unknown) {
        // ⚠️ The default is "balances visible". A user who turned privacy mode ON sees their
        // figures on screen again, and nothing anywhere says the preference failed to load.
        logger.warn('Privacy mode preference unreadable; balances default to visible', {
          origin: 'usePrivacyMode',
          error: String(e),
        })
      } finally {
        setIsLoaded(true)
      }
    }
    loadPreference()
  }, [])

  // Persist preference changes
  const setEnabled = useCallback(async (enabled: boolean) => {
    setIsEnabledState(enabled)
    try {
      await storage.set(PRIVACY_MODE_KEY, String(enabled))
    } catch (e: unknown) {
      // Applies for this session; the next launch shows balances again.
      logger.warn('Privacy mode preference not persisted', {
        origin: 'usePrivacyMode',
        enabled,
        error: String(e),
      })
    }
  }, [])

  const toggle = useCallback(() => {
    setEnabled(!isEnabled)
  }, [isEnabled, setEnabled])

  const mask = useCallback(
    <T>(value: T): T | string => {
      if (!isEnabled) return value
      return dotsFor(typeof value === 'string' ? value : undefined)
    },
    [isEnabled],
  )

  const value = useMemo(
    () => ({
      isEnabled: isLoaded ? isEnabled : false,
      toggle,
      setEnabled,
      getPlaceholder: dotsFor,
      mask,
    }),
    [isEnabled, isLoaded, toggle, setEnabled, mask],
  )

  return createElement(PrivacyContext.Provider, {value}, children)
}

/**
 * Hook to access shared privacy mode state.
 *
 * Must be used within a `<PrivacyProvider>`.
 *
 * @example
 * ```tsx
 * const {isEnabled, toggle, mask} = usePrivacyMode()
 *
 * return (
 *   <View>
 *     <Text>{mask(formatAda(balance))}</Text>
 *     <Button onPress={toggle} label={isEnabled ? 'Show' : 'Hide'} />
 *   </View>
 * )
 * ```
 */
export const usePrivacyMode = (): PrivacyMode => useContext(PrivacyContext)
