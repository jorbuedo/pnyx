/**
 * Web build of CameraScanner — delegates to WebCameraScanner (getUserMedia + local jsQR).
 *
 * Metro picks this file on web/extension builds (`.web.tsx` > `.tsx`), so `expo-camera`'s
 * web shim (and its `cdn.jsdelivr` literal in `useWebQRScanner`) never enters the bundle.
 *
 * @module
 */

import {WebCameraScanner} from './WebCameraScanner'

type CameraScannerProps = {
  onScan: (data: string) => void
  onCancel?: () => void
  /** Keep delivering distinct frames instead of firing once — needed to read an animated QR. */
  continuous?: boolean
  /** Replaces the standing hint, for a caller with something better to say (e.g. scan progress). */
  hint?: string
}

export function CameraScanner({onScan, onCancel, continuous = false, hint}: CameraScannerProps) {
  return (
    <WebCameraScanner
      onScan={onScan}
      continuous={continuous}
      {...(onCancel != null && {onCancel})}
      {...(hint != null && {hint})}
    />
  )
}
