/**
 * Native (iOS/Android) implementation of the Bluetooth adapter state API.
 *
 * Uses `react-native-ble-plx` because it is already a load-bearing dependency
 * (Trezor BLE flow + Ledger BLE transport via `@ledgerhq/react-native-hw-transport-ble`),
 * and `BleManager` is a singleton — instantiating one here does not conflict
 * with the Trezor manager.
 *
 * @module
 */

import {BleManager, type Subscription} from 'react-native-ble-plx'
import {logger} from '../logger'
import {BluetoothNotReadyError, type BluetoothState, classifyBluetoothState} from './bluetooth-state.shared'

export type {BluetoothNotReadyReason, BluetoothState} from './bluetooth-state.shared'
export {BluetoothNotReadyError, classifyBluetoothState, isBluetoothNotReadyError} from './bluetooth-state.shared'

let bleManager: BleManager | null = null

/**
 * Lazily create the BleManager.
 *
 * Deferred creation matters on iOS: instantiating `BleManager` triggers
 * `CBCentralManager` initialisation which can prompt for the Bluetooth
 * permission. We don't want that to fire just because the app launched —
 * it should fire only when the user opens a Bluetooth-driven flow.
 *
 * Exported so other native BLE adapters (vendor-agnostic scanner in
 * `hardware.native.ts`) can reuse the same singleton — instantiating two
 * managers in one process is wasteful and on iOS would trigger duplicate
 * permission prompts.
 */
export const getBleManager = (): BleManager => {
  if (bleManager === null) bleManager = new BleManager()
  return bleManager
}

/**
 * Read the current Bluetooth adapter state once.
 */
export const getBluetoothState = async (): Promise<BluetoothState> => {
  try {
    const raw = await getBleManager().state()
    return classifyBluetoothState(raw as unknown as string)
  } catch (e) {
    logger.warn('Failed to read Bluetooth state', {origin: 'bluetooth-state.native', cause: e})
    return 'unknown'
  }
}

/**
 * Subscribe to adapter state changes. Returns an unsubscribe function.
 *
 * The callback is invoked with the current state immediately upon subscription
 * (`emitCurrentState = true`). This means a subscriber is always primed with
 * the latest known state without an extra read.
 */
export const subscribeBluetoothState = (callback: (state: BluetoothState) => void): (() => void) => {
  const sub = getBleManager().onStateChange((raw) => {
    callback(classifyBluetoothState(raw as unknown as string))
  }, true)
  return () => sub.remove()
}

/**
 * Wait for the BLE adapter to reach `PoweredOn`.
 *
 * Resolves when the state becomes `'on'`. Rejects with a `BluetoothNotReadyError`
 * carrying the terminal reason (`'off' | 'unauthorized' | 'unsupported' | 'timeout'`).
 *
 * Transitional states (`'unknown'` — covers Resetting + Unknown) are ignored;
 * the adapter may still settle on PoweredOn (e.g. iOS is still asking for
 * permission, or the radio just woke up).
 */
export const waitForBluetoothReady = (timeoutMs = 10_000): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    let done = false
    // `sub` is declared up-front because `react-native-ble-plx` may invoke the
    // listener synchronously when `emitCurrentState=true` — if `sub` were assigned
    // by the `onStateChange` return value, the first invocation would see it
    // undefined and `sub.remove()` inside `finish` would throw.
    let sub: Subscription | null = null
    const finish = (action: () => void) => {
      if (done) return
      done = true
      clearTimeout(timeout)
      sub?.remove()
      action()
    }

    const timeout = setTimeout(
      () =>
        finish(() =>
          reject(
            new BluetoothNotReadyError({
              reason: 'timeout',
              message: 'Bluetooth adapter did not reach PoweredOn in time',
            }),
          ),
        ),
      timeoutMs,
    )

    sub = getBleManager().onStateChange((raw) => {
      const state = classifyBluetoothState(raw as unknown as string)
      if (state === 'on') {
        finish(() => resolve())
      } else if (state === 'off' || state === 'unauthorized' || state === 'unsupported') {
        finish(() => reject(new BluetoothNotReadyError({reason: state, message: `Bluetooth adapter state: ${state}`})))
      }
      // 'unknown' — keep waiting
    }, true)

    // If the listener fired synchronously and already finished, drop the
    // subscription we just stored.
    if (done) sub.remove()
  })
