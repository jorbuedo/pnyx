/**
 * Re-export BLE types from shared module.
 *
 * Preserves backward compatibility for existing consumers.
 */

export {
  type BluetoothDevice,
  BluetoothManagerError,
  type BluetoothManagerErrorCode,
  type DeviceBatteryLevelChangeEvent,
  type DeviceConnectionStatus,
  type DeviceConnectionStatusChangeEvent,
  type DevicePushNotificationEvent,
} from '../../trezor-protocol/ble/types'
