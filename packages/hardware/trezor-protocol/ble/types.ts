/**
 * Shared BLE types for Trezor transport.
 *
 * Platform-agnostic types used by both native and web BLE managers.
 */

export type BluetoothManagerErrorCode = 'DEVICE_NOT_FOUND' | 'CHARACTERISTIC_NOT_FOUND'

/**
 * Typed error for bluetooth manager operations.
 *
 * Replaces bare `throw new Error(...)` so callers can distinguish
 * bluetooth-specific failures from generic errors.
 */
export class BluetoothManagerError extends Error {
  override readonly name = 'BluetoothManagerError'
  readonly code: BluetoothManagerErrorCode

  constructor(code: BluetoothManagerErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

export type DeviceConnectionStatus =
  | {type: 'disconnected'}
  | {type: 'pairing'}
  | {type: 'paired'}
  | {type: 'connecting'}
  | {type: 'connected'}
  | {type: 'pairing-canceled'}
  | {type: 'pairing-error'; error: string}
  | {type: 'connection-error'; error: string}

export type DeviceConnectionStatusChangeEvent = {
  deviceId: string
  connectionStatus: DeviceConnectionStatus
}

export type DevicePushNotificationEvent = {
  deviceId: string
  data: number[]
}

export type DeviceBatteryLevelChangeEvent = {
  deviceId: string
  data: number[]
}

export type BluetoothDevice = {
  id: string
  name: string
  manufacturerData: number[]
  lastUpdatedTimestamp: number
  connectionStatus: DeviceConnectionStatus
}
