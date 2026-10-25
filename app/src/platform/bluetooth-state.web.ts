/**
 * Web/extension implementation of the Bluetooth adapter state API.
 *
 * BLE on web/extension goes through Web Bluetooth (when used at all) — there's
 * no equivalent of `BleManager.onStateChange()` exposed by the browser, so the
 * adapter state is reported as `'unsupported'`. Hardware-wallet flows on these
 * platforms use WebHID/WebUSB instead and never call into this module.
 *
 * @module
 */

import {BluetoothNotReadyError, type BluetoothState} from './bluetooth-state.shared'

export type {BluetoothNotReadyReason, BluetoothState} from './bluetooth-state.shared'
export {BluetoothNotReadyError, classifyBluetoothState, isBluetoothNotReadyError} from './bluetooth-state.shared'

/** No native BleManager on web — hardware BLE goes through Web Bluetooth. */
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
