/**
 * Platform-resolved Bluetooth state API.
 *
 * Metro selects `bluetooth-state.native.ts` on iOS/Android and
 * `bluetooth-state.web.ts` on the browser/extension. This file is the
 * default fallback (used by Node tooling that doesn't run platform
 * resolution, e.g. plain `tsc` in non-Metro contexts).
 *
 * @module
 */

import {BluetoothNotReadyError, type BluetoothState} from './bluetooth-state.shared'

export type {BluetoothNotReadyReason, BluetoothState} from './bluetooth-state.shared'
export {BluetoothNotReadyError, classifyBluetoothState, isBluetoothNotReadyError} from './bluetooth-state.shared'

/** Native override provides the real BleManager; the fallback has none. */
export const getBleManager = (): null => null

export const getBluetoothState = async (): Promise<BluetoothState> => 'unsupported'

export const subscribeBluetoothState =
  (_callback: (state: BluetoothState) => void): (() => void) =>
  () => {}

export const waitForBluetoothReady = async (_timeoutMs?: number): Promise<void> => {
  throw new BluetoothNotReadyError({
    reason: 'unsupported',
    message: 'Bluetooth adapter state is not exposed on this platform',
  })
}
