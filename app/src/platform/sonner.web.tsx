/**
 * Web platform toast notifications — re-exports sonner for browser/extension.
 *
 * Wraps sonner's `Toaster` so every custom toast renders centered in the
 * viewport. By default sonner gives custom toasts a 356px-wide track and
 * positions the toast `<li>` at `left: 0` of that track (no `width` /
 * `display: flex` is applied unless `data-styled='true'`, which only happens
 * for sonner's built-in title/description toasts). For our React Native
 * custom Toast pill that means the pill is content-sized and pinned to the
 * left edge of the track — visually NOT centered. We override the `<li>` to
 * be `width: 100%; display: flex; justify-content: center` so the pill
 * centers within the track, which itself is already centered on screen.
 *
 * @module
 */

import type React from 'react'
// biome-ignore lint/style/noRestrictedImports: platform re-export
import type {ExternalToast, ToasterProps} from 'sonner'
// biome-ignore lint/style/noRestrictedImports: platform re-export
import {Toaster as SonnerToaster, toast} from 'sonner'

// biome-ignore lint/style/noRestrictedImports: platform re-export
export * from 'sonner'

const centeredToastStyle: React.CSSProperties = {
  width: '100%',
  display: 'flex',
  justifyContent: 'center',
  background: 'transparent',
  border: 'none',
  boxShadow: 'none',
  padding: 0,
}

export const Toaster = (props: ToasterProps) => {
  const {toastOptions, ...rest} = props
  return (
    <SonnerToaster
      {...rest}
      toastOptions={{
        ...toastOptions,
        style: {...centeredToastStyle, ...toastOptions?.style},
      }}
    />
  )
}

/**
 * Normalized `toast.custom()` wrapper with a unified factory-based API.
 *
 * `sonner` (web v2) internally calls `jsx(id)`, so it requires a factory
 * function rather than a plain `ReactElement`. We pass the factory through
 * directly, matching sonner's native expectations.
 */
export const toastCustom = (
  factory: (id: string | number) => React.ReactElement,
  options?: ExternalToast,
  // biome-ignore lint/suspicious/noExplicitAny: React 19 project types vs sonner's bundled @types/react@18 — structurally identical at runtime
): string | number => toast.custom(factory as any, options as any)
