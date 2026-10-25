/**
 * Platform-specific toast notifications — re-exports sonner-native on React Native.
 *
 * Platform-specific implementations are in:
 * - sonner.web.ts (browser/extension — sonner)
 * - sonner.ts (React Native — sonner-native)
 *
 * Metro automatically picks the correct file based on the platform.
 *
 * @module
 */

import type React from 'react'
// biome-ignore lint/style/noRestrictedImports: platform re-export
import type {ToastProps} from 'sonner-native'
// biome-ignore lint/style/noRestrictedImports: platform re-export
import {toast} from 'sonner-native'

// biome-ignore lint/style/noRestrictedImports: platform re-export
export * from 'sonner-native'

/**
 * Normalized `toast.custom()` wrapper with a unified factory-based API.
 *
 * `sonner-native` requires a plain `ReactElement` (not a function). We
 * pre-generate the toast id so the factory can close over it — enabling
 * `toast.dismiss(id)` inside `onClose` even on native.
 */
export const toastCustom = (
  factory: (id: string | number) => React.ReactElement,
  options?: ToastProps,
): string | number => {
  const id = options?.id ?? Date.now()
  // biome-ignore lint/suspicious/noExplicitAny: React 19 project types vs sonner-native's bundled @types/react@18 — structurally identical at runtime
  return toast.custom(factory(id) as any, {...options, id} as any)
}
