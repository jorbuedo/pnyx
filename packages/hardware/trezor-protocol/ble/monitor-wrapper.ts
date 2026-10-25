/**
 * Safe monitor callback wrapper for BLE characteristic notifications.
 *
 * Prevents app crashes from:
 * - Unhandled monitor errors (currently silently swallowed)
 * - Exceptions thrown inside monitor callbacks
 *
 * Both native and web BLE managers use this to wrap their characteristic
 * monitoring, ensuring errors are always logged and never crash the app.
 */

export type MonitorErrorHandler = (error: unknown, context: {deviceId: string; characteristic: string}) => void

/**
 * Create a safe callback for BLE characteristic monitoring (native).
 *
 * The native react-native-ble-plx `monitor()` callback receives
 * `(error: BleError | null, characteristic: Characteristic | null)`.
 * This wrapper:
 * 1. Logs monitor errors via onError instead of silently ignoring them
 * 2. Wraps the value callback in try-catch to prevent unhandled throws
 */
export const createSafeNativeMonitorCallback = <T>(
  deviceId: string,
  characteristic: string,
  callback: (value: T) => void,
  onError: MonitorErrorHandler,
): ((monitorError: unknown, value: T | null) => void) => {
  return (monitorError: unknown, value: T | null) => {
    if (monitorError) {
      onError(monitorError, {deviceId, characteristic})
      return
    }
    if (value != null) {
      try {
        callback(value)
      } catch (err) {
        onError(err, {deviceId, characteristic})
      }
    }
  }
}

/**
 * Create a safe callback for BLE characteristic monitoring (web).
 *
 * The Web Bluetooth API fires `characteristicvaluechanged` events.
 * This wrapper catches and reports any errors from the value callback.
 */
export const createSafeWebMonitorCallback = <T>(
  deviceId: string,
  characteristic: string,
  callback: (value: T) => void,
  onError: MonitorErrorHandler,
): ((value: T) => void) => {
  return (value: T) => {
    try {
      callback(value)
    } catch (err) {
      onError(err, {deviceId, characteristic})
    }
  }
}
