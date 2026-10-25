/**
 * Theme provider that owns the React-side concerns Unistyles can't:
 * persistence of the user's mode preference, system color-scheme listener,
 * the document.documentElement.style.colorScheme web bridge, and the
 * imperative call to UnistylesRuntime.setTheme that switches the active theme.
 *
 * Theme reads (theme, isDark, colors, insets, ...) come from Unistyles —
 * useUnistyles() / withUnistyles() / StyleSheet.create((theme, rt) => …).
 * This provider exposes only mode controls.
 *
 * @module
 */

import {
  createContext,
  type ReactNode,
  startTransition,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {Appearance} from 'react-native'
import {UnistylesRuntime} from 'react-native-unistyles'
import {logger} from '../logger'
import {isNative, platformIsWeb} from '../platform'
import {deviceStorage as storage} from '../platform/storage'
import {type AccentName, accentNames} from '../theme/accent-ramps'
import {themeNameFor, type themes} from '../theme/deprecated'

/**
 * Theme mode preference.
 *
 * - 'light' / 'dark': explicit user preference
 * - 'system': follows the device (native) or browser (web/extension) color scheme
 */
export type ThemeMode = 'light' | 'dark' | 'system'

/**
 * Set the document color-scheme to prevent OS dark mode from leaking through.
 * This affects native browser elements like scrollbars, form controls, etc.
 */
function setDocumentColorScheme(isDark: boolean) {
  if (platformIsWeb && typeof document !== 'undefined') {
    document.documentElement.style.colorScheme = isDark ? 'dark' : 'light'
  }
}

/**
 * Detect the current system color scheme.
 *
 * - Native: uses React Native's Appearance API
 * - Web / extension: uses window.matchMedia('(prefers-color-scheme: dark)')
 */
function getSystemDark(): boolean {
  if (isNative) {
    return Appearance.getColorScheme() === 'dark'
  }
  if (platformIsWeb && typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  }
  return false
}

/**
 * Parse a stored theme value, handling legacy 'true'/'false' strings.
 */
function parseStoredTheme(stored: string | null, defaultMode: ThemeMode): {mode: ThemeMode; systemIsDark: boolean} {
  if (stored === 'system') {
    return {mode: 'system', systemIsDark: getSystemDark()}
  }
  if (stored === 'dark' || stored === 'true') {
    return {mode: 'dark', systemIsDark: false}
  }
  if (stored === 'light' || stored === 'false') {
    return {mode: 'light', systemIsDark: false}
  }
  // No stored preference — use prop default
  return {mode: defaultMode, systemIsDark: defaultMode === 'system' ? getSystemDark() : false}
}

/**
 * Apply the Unistyles theme and document color-scheme synchronously.
 */
function applyThemeRuntime(dark: boolean, accent: AccentName) {
  setDocumentColorScheme(dark)
  if (!UnistylesRuntime.hasAdaptiveThemes) {
    // Palette and mode are pre-multiplied into the registry, because Unistyles switches by name —
    // `themeNameFor` is the single place that spelling lives.
    UnistylesRuntime.setTheme(themeNameFor(accent, dark) as keyof typeof themes)
  }
}

export type ThemeContextValue = {
  /** The user's chosen theme mode (light, dark, or system) */
  themeMode: ThemeMode
  /** Set the theme mode */
  setThemeMode: (mode: ThemeMode) => void
  /** Toggle between light and dark themes */
  toggleTheme: () => void
  /**
   * The chosen colour scheme. Independent of {@link themeMode}: every scheme has a light and a dark
   * form, so picking one never changes whether the app is light or dark.
   */
  accent: AccentName
  /** Set the colour scheme. */
  setAccent: (accent: AccentName) => void
}

export const ThemeContext = createContext<ThemeContextValue | null>(null)

export type ThemeProviderProps = {
  /** Provider children */
  children: ReactNode
  /** Default theme mode when no preference is stored (defaults to 'system') */
  defaultMode?: ThemeMode
  /** Storage key for persisting theme preference */
  storageKey?: string
  /** Storage key for persisting the colour scheme */
  accentStorageKey?: string
}

/**
 * @example
 * ```tsx
 * import { ThemeProvider, useTheme } from '@/providers'
 *
 * function ModePicker() {
 *   const {themeMode, setThemeMode} = useTheme()
 *   return (
 *     <Button label="Follow System" onPress={() => setThemeMode('system')} />
 *   )
 * }
 *
 * export default function App() {
 *   return (
 *     <ThemeProvider>
 *       <ModePicker />
 *     </ThemeProvider>
 *   )
 * }
 * ```
 */
export const ThemeProvider = ({
  children,
  defaultMode = 'system' as ThemeMode,
  storageKey = 'pnyx_theme_mode',
  accentStorageKey = 'pnyx_theme_accent',
}: ThemeProviderProps) => {
  const [themeMode, setThemeModeState] = useState<ThemeMode>(defaultMode)
  const [accent, setAccentState] = useState<AccentName>('violet')
  const [systemIsDark, setSystemIsDark] = useState<boolean>(() => (defaultMode === 'system' ? getSystemDark() : false))
  const [mounted, setMounted] = useState(false)

  // Ref to avoid stale closure in setThemeMode callback
  const systemIsDarkRef = useRef(systemIsDark)
  useEffect(() => {
    systemIsDarkRef.current = systemIsDark
  }, [systemIsDark])

  // Same reason as `systemIsDarkRef`: both setters read the other axis, and a stale closure would
  // apply a theme name that mixes the previous scheme with the new mode.
  const accentRef = useRef(accent)
  useEffect(() => {
    accentRef.current = accent
  }, [accent])

  const themeModeRef = useRef(themeMode)
  useEffect(() => {
    themeModeRef.current = themeMode
  }, [themeMode])

  const isDark = themeMode === 'system' ? systemIsDark : themeMode === 'dark'

  const setThemeMode = useCallback((mode: ThemeMode) => {
    const dark = mode === 'system' ? systemIsDarkRef.current : mode === 'dark'
    // Selection state stays urgent so the picked row updates instantly.
    setThemeModeState(mode)
    // UnistylesRuntime.setTheme flips the native shadow tree synchronously, but
    // every useUnistyles() subscriber (~hundreds, app-wide) re-renders in JS on
    // the same tick. Marking that cascade as a transition keeps it interruptible
    // so it never blocks the tap/animation frame — the device-only jank in
    // theme-switch jank. useUnistyles subscribes via useState, so it honours transitions.
    startTransition(() => {
      applyThemeRuntime(dark, accentRef.current)
    })
  }, [])

  const setAccent = useCallback((next: AccentName) => {
    setAccentState(next)
    // Same transition reasoning as `setThemeMode`: the swatch updates urgently, the app-wide
    // recolour is interruptible so it cannot block the tap frame.
    startTransition(() => {
      const dark = themeModeRef.current === 'system' ? systemIsDarkRef.current : themeModeRef.current === 'dark'
      applyThemeRuntime(dark, next)
    })
  }, [])

  // Set initial color-scheme immediately to prevent flash
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally runs only on mount to prevent flash
  useEffect(() => {
    setDocumentColorScheme(isDark)
  }, [])

  // Load persisted preference on mount
  // biome-ignore lint/correctness/useExhaustiveDependencies: setThemeMode is stable
  useEffect(() => {
    const loadTheme = async () => {
      try {
        const stored = await storage.get(storageKey)
        const {mode, systemIsDark: sysIsDark} = parseStoredTheme(stored, defaultMode)
        if (mode === 'system') {
          setSystemIsDark(sysIsDark)
          systemIsDarkRef.current = sysIsDark
        }
        // Apply without going through setThemeMode to avoid double render —
        // set state directly and apply runtime once
        setThemeModeState(mode)
        const storedAccent = await storage.get(accentStorageKey)
        // Validated against the registry rather than trusted: a scheme removed in a later build
        // would otherwise name a theme Unistyles has never heard of.
        const nextAccent = accentNames.find((name) => name === storedAccent) ?? 'violet'
        setAccentState(nextAccent)
        accentRef.current = nextAccent
        const dark = mode === 'system' ? sysIsDark : mode === 'dark'
        applyThemeRuntime(dark, nextAccent)
      } catch (error) {
        // Falls back to the default scheme in light/system — but "no preference stored" and "the
        // read failed" are different facts, and a theme that silently reverts is how the second
        // stays invisible.
        logger.warn('[Theme] stored preference could not be read; using defaults', {
          origin: 'ThemeProvider',
          error: String(error),
        })
      }
      setMounted(true)
    }
    loadTheme()
  }, [storageKey])

  // Persist themeMode when it changes
  useEffect(() => {
    if (!mounted) return
    storage.set(storageKey, themeMode)
  }, [themeMode, mounted, storageKey])

  // Persisted separately from the mode: the two axes are independent, so a scheme must survive a
  // light/dark change and vice versa.
  useEffect(() => {
    if (!mounted) return
    storage.set(accentStorageKey, accent)
  }, [accent, mounted, accentStorageKey])

  // Listen for system theme changes when mode is 'system'
  useEffect(() => {
    if (themeMode !== 'system') return

    if (isNative) {
      const sub = Appearance.addChangeListener(({colorScheme}) => {
        const dark = colorScheme === 'dark'
        setSystemIsDark(dark)
        applyThemeRuntime(dark, accentRef.current)
      })
      return () => sub.remove()
    }

    if (platformIsWeb && typeof window !== 'undefined' && window.matchMedia) {
      const mq = window.matchMedia('(prefers-color-scheme: dark)')
      const handler = (e: MediaQueryListEvent) => {
        const dark = e.matches
        setSystemIsDark(dark)
        applyThemeRuntime(dark, accentRef.current)
      }
      mq.addEventListener('change', handler)
      return () => mq.removeEventListener('change', handler)
    }

    return undefined
  }, [themeMode])

  const toggleTheme = useCallback(() => {
    setThemeMode(isDark ? 'light' : 'dark')
  }, [isDark, setThemeMode])

  const value = useMemo<ThemeContextValue>(
    () => ({
      themeMode,
      setThemeMode,
      toggleTheme,
      accent,
      setAccent,
    }),
    [themeMode, setThemeMode, toggleTheme, accent, setAccent],
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

/**
 * Hook to access the theme context.
 *
 * @throws Error if used outside of ThemeProvider
 */
export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext)
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider')
  }
  return context
}
