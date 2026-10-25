/**
 * Shared BLE connection state management.
 *
 * Manages event routing for device connection status, push notifications,
 * and battery level changes. Used by both native and web BLE managers.
 */

import type {EventEmitter} from '../../trezor-native/event-emitter'
import type {
  BluetoothDevice,
  DeviceBatteryLevelChangeEvent,
  DeviceConnectionStatusChangeEvent,
  DevicePushNotificationEvent,
} from './types'

type Subscription = {remove: () => void}

const eventNames = {
  nearbyDevicesChange: 'nearbyDevicesChange',
  deviceConnectionStatusChange: 'deviceConnectionStatusChange',
  devicePushNotification: 'devicePushNotification',
  deviceBatteryLevelChange: 'deviceBatteryLevelChange',
} as const

export type BleConnectionStateOptions = {
  /** Whether to track nearby devices (native scanning only, not web). */
  trackNearbyDevices?: boolean
}

export const createBleConnectionState = (emitter: EventEmitter, options: BleConnectionStateOptions = {}) => {
  let nearbyDevices: BluetoothDevice[] = []

  const subscribeTo = (eventName: string, listener: (arg: unknown) => void): Subscription => {
    emitter.on(eventName, listener)
    return {remove: () => emitter.off(eventName, listener)}
  }

  const emitNearbyDevicesChange = () => {
    emitter.emit(eventNames.nearbyDevicesChange, nearbyDevices)
  }

  const updateDeviceConnectionStatusChange = (event: DeviceConnectionStatusChangeEvent) => {
    const {deviceId, connectionStatus} = event
    if (options.trackNearbyDevices) {
      if (connectionStatus.type === 'pairing-canceled' || connectionStatus.type === 'pairing-error') {
        nearbyDevices = nearbyDevices.filter((d) => d.id !== deviceId)
      } else {
        nearbyDevices = nearbyDevices.map((d) =>
          d.id === deviceId ? {...d, lastUpdatedTimestamp: Date.now(), connectionStatus} : d,
        )
      }
    }
    emitter.emit(eventNames.deviceConnectionStatusChange, event)
    if (options.trackNearbyDevices) emitNearbyDevicesChange()
  }

  const emitDevicePushNotification = (event: DevicePushNotificationEvent) => {
    emitter.emit(eventNames.devicePushNotification, event)
  }

  const emitDeviceBatteryLevelChange = (event: DeviceBatteryLevelChangeEvent) => {
    emitter.emit(eventNames.deviceBatteryLevelChange, event)
  }

  // --- Nearby device management (native scanning only) ---

  const addOrUpdateNearbyDevice = (device: BluetoothDevice): boolean => {
    const index = nearbyDevices.findIndex((d) => d.id === device.id)
    if (index >= 0) {
      // biome-ignore lint/style/noNonNullAssertion: index >= 0 guarantees element exists
      const old = nearbyDevices[index]!
      device.connectionStatus = old.connectionStatus
      nearbyDevices[index] = device
      return old.manufacturerData[0] !== device.manufacturerData[0]
    }
    nearbyDevices.unshift(device)
    return true
  }

  const removeNearbyDevice = (deviceId: string) => {
    nearbyDevices = nearbyDevices.filter((d) => d.id !== deviceId)
  }

  const removeStaleDevices = (cutoffMs: number): boolean => {
    const cutoffTimestamp = Date.now() - cutoffMs
    const filtered = nearbyDevices.filter(
      ({lastUpdatedTimestamp, connectionStatus: {type: status}}) =>
        status !== 'disconnected' || lastUpdatedTimestamp > cutoffTimestamp,
    )
    if (filtered.length !== nearbyDevices.length) {
      nearbyDevices = filtered
      emitNearbyDevicesChange()
      return true
    }
    return false
  }

  // --- Subscription helpers ---

  const onNearbyDevicesChange = (listener: (devices: BluetoothDevice[]) => void): Subscription =>
    subscribeTo(eventNames.nearbyDevicesChange, listener as (arg: unknown) => void)

  const onDeviceConnectionStatusChange = (listener: (event: DeviceConnectionStatusChangeEvent) => void): Subscription =>
    subscribeTo(eventNames.deviceConnectionStatusChange, listener as (arg: unknown) => void)

  const onDevicePushNotification = (listener: (event: DevicePushNotificationEvent) => void): Subscription =>
    subscribeTo(eventNames.devicePushNotification, listener as (arg: unknown) => void)

  const onDeviceBatteryLevelChange = (listener: (event: DeviceBatteryLevelChangeEvent) => void): Subscription =>
    subscribeTo(eventNames.deviceBatteryLevelChange, listener as (arg: unknown) => void)

  return {
    updateDeviceConnectionStatusChange,
    emitDevicePushNotification,
    emitDeviceBatteryLevelChange,
    emitNearbyDevicesChange,
    addOrUpdateNearbyDevice,
    removeNearbyDevice,
    removeStaleDevices,
    onNearbyDevicesChange,
    onDeviceConnectionStatusChange,
    onDevicePushNotification,
    onDeviceBatteryLevelChange,
  }
}

export type BleConnectionState = ReturnType<typeof createBleConnectionState>
