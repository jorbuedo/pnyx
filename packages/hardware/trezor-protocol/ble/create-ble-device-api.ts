/**
 * Shared BLE device API factory.
 *
 * Eliminates duplication between native and web bluetooth-device-api.ts files.
 * Both are 98% identical — only the manager instance differs.
 */

import {createEventEmitter} from '../../trezor-native/event-emitter'
import type {DeviceApi, ErrorResult, Logger, OpenDeviceChannel, Success} from '../../trezor-native/transport/types'
import {error, success} from '../../trezor-native/transport/types'
import {DEVICE_TYPE} from '../constants'
import * as ERRORS from '../errors'
import type {DescriptorApiLevel, PathInternal} from '../types'
import type {
  DeviceBatteryLevelChangeEvent,
  DeviceConnectionStatusChangeEvent,
  DevicePushNotificationEvent,
} from './types'

type Subscription = {remove: () => void}

/**
 * Minimal interface that both native and web BLE managers satisfy.
 * Used by the shared device API factory.
 */
export type BleManagerInterface = {
  onDeviceConnectionStatusChange: (listener: (event: DeviceConnectionStatusChangeEvent) => void) => Subscription
  onDevicePushNotification: (listener: (event: DevicePushNotificationEvent) => void) => Subscription
  onDeviceBatteryLevelChange: (listener: (event: DeviceBatteryLevelChangeEvent) => void) => Subscription
  getConnectedDeviceIds: () => string[]
  isDeviceConnected: (id: string) => boolean
  read: (id: string, signal?: AbortSignal) => Promise<Success<Uint8Array> | ErrorResult>
  write: (id: string, message: Uint8Array) => Promise<void>
  cancelRead: (id: string) => void
}

/**
 * Create a DeviceApi backed by a BLE manager.
 *
 * The manager handles all BLE-specific concerns (padding, throttling, etc.).
 * This factory provides the DeviceApi interface for the transport adapter.
 */
export const createBleDeviceApi = (manager: BleManagerInterface, params: {logger?: Logger | undefined}): DeviceApi => {
  const {logger} = params
  const emitter = createEventEmitter()
  const pushNotificationSubscribedDevices = new Set<string>()
  const batteryLevelChangeSubscribedDevices = new Set<string>()

  const subscriptions = [
    manager.onDeviceConnectionStatusChange((event) => {
      logger?.debug('onDeviceConnectionStatusChange', event)
      emitter.emit('transport-interface-change', getDescriptors())
    }),
    manager.onDevicePushNotification(({deviceId, data}) => {
      logger?.debug('onDevicePushNotificationEvent', {deviceId, data})
      if (pushNotificationSubscribedDevices.has(deviceId)) {
        emitter.emit('trezor-push-notification', {id: deviceId, data})
      }
    }),
    manager.onDeviceBatteryLevelChange(({deviceId, data}) => {
      logger?.debug('onDeviceBatteryLevelChange', {deviceId, data})
      if (batteryLevelChangeSubscribedDevices.has(deviceId)) {
        emitter.emit('battery-level', {id: deviceId, data})
      }
    }),
  ]

  const getDescriptors = (): DescriptorApiLevel[] => {
    const connectedDeviceIds = manager.getConnectedDeviceIds()
    return connectedDeviceIds.map((deviceId) => ({
      path: deviceId as PathInternal,
      type: DEVICE_TYPE.TypeBluetooth,
      id: deviceId,
      apiType: 'bluetooth' as const,
    }))
  }

  const enumerate: DeviceApi['enumerate'] = async () => {
    try {
      return success(getDescriptors())
    } catch (err) {
      logger?.error('enumerate error', err)
      return {success: false, error: ERRORS.UNEXPECTED_ERROR, message: String(err)}
    }
  }

  const listen: DeviceApi['listen'] = () => {
    // BLE scanning/connection is driven by the manager, no-op here
  }

  const read: DeviceApi['read'] = async (path, signal?) => {
    if (!manager.isDeviceConnected(path)) {
      return error(ERRORS.DEVICE_NOT_FOUND)
    }

    try {
      const result = await manager.read(path, signal)
      if (!result.success) {
        return error(ERRORS.INTERFACE_DATA_TRANSFER)
      }
      return result
    } catch (err: unknown) {
      logger?.error('read error', err)
      return error(ERRORS.INTERFACE_DATA_TRANSFER, err instanceof Error ? err.message : String(err))
    }
  }

  const write: DeviceApi['write'] = async (path, buffer) => {
    if (!manager.isDeviceConnected(path)) {
      return error(ERRORS.DEVICE_NOT_FOUND)
    }

    try {
      // No padding here — the manager handles all BLE write concerns
      // (throttling, padding to 244 bytes, writeWithResponse)
      await manager.write(path, buffer)
      return success(undefined)
    } catch (err: unknown) {
      logger?.error('write error', err)
      return error(ERRORS.INTERFACE_DATA_TRANSFER, err instanceof Error ? err.message : String(err))
    }
  }

  const openDevice: DeviceApi['openDevice'] = async (path, options?) => {
    const channel = options?.channel as OpenDeviceChannel | undefined
    if (channel === 'trezor-push-notification') {
      pushNotificationSubscribedDevices.add(path)
    } else if (channel === 'battery-level') {
      batteryLevelChangeSubscribedDevices.add(path)
    }
    // BT does not need to be opened, it is opened when connected
    return success(undefined)
  }

  const closeDevice: DeviceApi['closeDevice'] = async (path, options?) => {
    const channel = options?.channel as OpenDeviceChannel | undefined
    if (channel === 'read') {
      manager.cancelRead(path)
    } else if (channel === 'trezor-push-notification') {
      pushNotificationSubscribedDevices.delete(path)
    } else if (channel === 'battery-level') {
      batteryLevelChangeSubscribedDevices.delete(path)
    }
    return success(undefined)
  }

  const dispose: DeviceApi['dispose'] = () => {
    for (const s of subscriptions) s.remove()
  }

  return {
    type: 'bluetooth',
    chunkSize: 244,
    enumerate,
    listen,
    read,
    write,
    openDevice,
    closeDevice,
    dispose,
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    once: emitter.once.bind(emitter),
    emit: emitter.emit.bind(emitter),
  }
}
