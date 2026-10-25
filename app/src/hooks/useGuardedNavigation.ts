/**
 * Re-entrancy guard for screen navigations and similar one-shot user actions.
 *
 * Replaces the per-screen `navigatingRef` / `isNavigating` open-coded pattern
 * (e.g. `app/send/asset.tsx`, `app/onboarding/restore.tsx`).
 *
 * Pairs `useRef` (reads fresh in every callback — no stale-closure pitfall on
 * a fast double-tap) with `useState` (drives the `isNavigating` boolean for
 * visual feedback) and `useFocusEffect` (auto-resets on focus return so users
 * can navigate forward again after backing into the screen).
 *
 * @module
 */

import {useFocusEffect} from 'expo-router'
import {useCallback, useMemo, useRef, useState} from 'react'
import {logger} from '../logger'

export type UseGuardedNavigation = {
  /**
   * Wraps a callback that should run at most once at a time. While the guard
   * is set, calls are dropped silently. The guard releases:
   *  - automatically when the screen regains focus (so backing into it
   *    re-arms the action)
   *  - automatically if the wrapped fn throws or rejects (so transient
   *    failures don't permanently lock the action)
   *  - manually via {@link reset} when a code path decides not to navigate
   *    (e.g. the handler opens a sheet instead of pushing a screen)
   */
  guard: (fn: () => unknown) => void
  /**
   * Synchronously try to acquire the guard without wrapping a callback.
   * Returns `true` if the guard was acquired (caller is now responsible for
   * releasing via {@link reset} or letting the focus reset clear it), or
   * `false` if it was already held.
   *
   * Use this when the acquisition is conditional and a simple wrap doesn't
   * fit — e.g. inside an already-running async callback that only sometimes
   * needs to arm an additional guard.
   */
  tryEnter: () => boolean
  /** True while the guard is set — bind to `isDisabled` / `isLoading`. */
  isNavigating: boolean
  /** Manually clear the guard. */
  reset: () => void
}

export const useGuardedNavigation = (): UseGuardedNavigation => {
  // Ref reads fresh on every call. Reading `isNavigating` (state) inside a
  // callback would see the value at render time — fine for visual disable,
  // but *not* fine for re-entrancy: a second tap fires before React has
  // committed the `setIsNavigating(true)` update.
  const guardedRef = useRef(false)
  const [isNavigating, setIsNavigating] = useState(false)

  const reset = useCallback(() => {
    guardedRef.current = false
    setIsNavigating(false)
  }, [])

  // expo-router keeps screens mounted on forward navigation; without this
  // reset the guard would stay armed forever after the user backs in.
  useFocusEffect(reset)

  const tryEnter = useCallback(() => {
    if (guardedRef.current) return false
    guardedRef.current = true
    setIsNavigating(true)
    return true
  }, [])

  const guard = useCallback(
    (fn: () => unknown) => {
      if (!tryEnter()) return

      let result: unknown
      try {
        result = fn()
      } catch (err) {
        reset()
        throw err
      }
      if (result instanceof Promise) {
        // Safety-net release on rejection: the guard must not stay latched.
        result.catch((e) => {
          logger.warn('Guarded action rejected; releasing the guard', {
            origin: 'useGuardedNavigation',
            error: String(e),
          })
          reset()
        })
      }
    },
    [reset, tryEnter],
  )

  // Memoize the returned object so callers can put the whole hook result in
  // a dep array without re-running effects every render. The inner functions
  // are already stable via `useCallback`; this just stabilizes the wrapper.
  return useMemo(() => ({guard, tryEnter, isNavigating, reset}), [guard, tryEnter, isNavigating, reset])
}
