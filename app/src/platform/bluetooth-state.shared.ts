/**
 * Shared types and pure helpers for the bluetooth-state platform module.
 *
 * The classifier here is intentionally free of React Native deps so that
 * unit tests can import it directly without pulling in `react-native-ble-plx`.
 *
 * @module
 */

import {BluetoothNotReadyError, type BluetoothNotReadyReason} from '@pnyx/hardware'

export {BluetoothNotReadyError}
export type {BluetoothNotReadyReason}

/**
 * Normalised Bluetooth adapter state across platforms.
 */
export type BluetoothState = 'on' | 'off' | 'unauthorized' | 'unsupported' | 'unknown'

/**
 * Map a raw `react-native-ble-plx` `State` value into our normalised state.
 *
 * Resetting and Unknown are deliberately collapsed into `'unknown'` so callers
 * can keep waiting — the adapter is mid-transition, not terminally bad.
 */
export const classifyBluetoothState = (rawState: string | null | undefined): BluetoothState => {
  switch (rawState) {
    case 'PoweredOn':
      return 'on'
    case 'PoweredOff':
      return 'off'
    case 'Unauthorized':
      return 'unauthorized'
    case 'Unsupported':
      return 'unsupported'
    default:
      return 'unknown'
  }
}

export const isBluetoothNotReadyError = (error: unknown): error is BluetoothNotReadyError =>
  typeof error === 'object' &&
  error !== null &&
  '_tag' in error &&
  (error as {_tag?: unknown})._tag === 'BluetoothNotReadyError'
