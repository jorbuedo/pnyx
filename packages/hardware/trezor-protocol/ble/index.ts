/**
 * Shared BLE module for Trezor transport.
 *
 * Platform-agnostic BLE logic shared by native (react-native-ble-plx)
 * and web (Web Bluetooth API) managers.
 */

export type {BleConnectionState, BleConnectionStateOptions} from './connection-state'
export {createBleConnectionState} from './connection-state'
export {BatteryService, BLE_CHUNK_SIZE, BLE_WRITE_MIN_GAP_MS, TrezorService} from './constants'
export type {BleManagerInterface} from './create-ble-device-api'
export {createBleDeviceApi} from './create-ble-device-api'
export type {HealthMonitor, HealthMonitorOptions} from './health-monitor'
export {createHealthMonitor} from './health-monitor'
export type {CBErrorClassification} from './ios-errors'
export {classifyBleConnectionError, classifyCBError} from './ios-errors'
export type {MonitorErrorHandler} from './monitor-wrapper'
export {createSafeNativeMonitorCallback, createSafeWebMonitorCallback} from './monitor-wrapper'
export {
  type BluetoothDevice,
  BluetoothManagerError,
  type BluetoothManagerErrorCode,
  type DeviceBatteryLevelChangeEvent,
  type DeviceConnectionStatus,
  type DeviceConnectionStatusChangeEvent,
  type DevicePushNotificationEvent,
} from './types'
export {createBleWriteHelper} from './write-helper'
