/**
 * Imperative toast hook.
 *
 * Thin wrapper around the platform-specific sonner abstraction that renders
 * our themed {@link Toast} component inside the app-level `<Toaster>`.
 *
 * @module
 */

import {useCallback} from 'react'
import {Toast, type ToastProps} from '../components/Toast'
import {isNative} from '../platform'
import {toast, toastCustom} from '../platform/sonner'

export type ShowToastOptions = ToastProps & {
  /**
   * Duration in milliseconds before the toast auto-dismisses.
   * @default 4000
   */
  duration?: number
}

/**
 * Imperative toast helper built on the platform-specific sonner abstraction.
 *
 * Uses {@link toastCustom} — a normalized wrapper around `toast.custom()` that
 * handles the API difference between `sonner` (web v2, requires a factory
 * function) and `sonner-native` (requires a plain ReactElement).
 *
 * @example
 * ```tsx
 * const { showToast } = useToast()
 *
 * showToast({ variant: 'success', message: 'Transaction submitted' })
 * showToast({ variant: 'neutral', message: 'Copied!' })
 * ```
 */
export const useToast = () => {
  const showToast = useCallback(({duration = 4000, ...props}: ShowToastOptions) => {
    return toastCustom(
      (id) => {
        const action = props.action
          ? {
              ...props.action,
              onPress: () => {
                toast.dismiss(id)
                props.action?.onPress()
              },
            }
          : undefined

        return <Toast {...props} {...(action ? {action} : {})} />
      },
      {
        duration,
        position: isNative ? 'top-center' : 'bottom-center',
        // biome-ignore lint/suspicious/noExplicitAny: React 19 project types vs sonner-native's bundled @types/react@18 — structurally identical at runtime
      } as any,
    )
  }, [])

  return {showToast}
}
