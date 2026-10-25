/// <reference types="@types/web-bluetooth" />

/**
 * Web Bluetooth manager for Trezor BLE transport.
 *
 * Port of trezor-native/bluetooth/bluetooth-manager.ts using the Web Bluetooth API
 * instead of react-native-ble-plx. Only works in contexts where navigator.bluetooth
 * is available (e.g., fullscreen browser tabs, not extension popups).
 *
 * Key differences from native:
 * - No continuous scanning — Web Bluetooth uses a one-shot picker (requestDevice)
 * - No MTU negotiation API (browser handles automatically)
 * - Data is DataView/Uint8Array, not base64 strings
 * - Same readMessageBuffer() from @trezor/transport for chunk reassembly
 */

import {createEventEmitter} from '../trezor-native/event-emitter'
import {createBleConnectionState} from '../trezor-protocol/ble/connection-state'
import {BatteryService, TrezorService} from '../trezor-protocol/ble/constants'
import {createHealthMonitor} from '../trezor-protocol/ble/health-monitor'
import {createSafeWebMonitorCallback} from '../trezor-protocol/ble/monitor-wrapper'
import {BluetoothManagerError, type BluetoothDevice as TrezorBluetoothDevice} from '../trezor-protocol/ble/types'
import {createBleWriteHelper} from '../trezor-protocol/ble/write-helper'
import {readMessageBuffer} from '../trezor-protocol/utils'

type DeviceId = string

type WebBleDeviceWithMetadata = {
  gattDevice: globalThis.BluetoothDevice
  server: BluetoothRemoteGATTServer
  writeCharacteristic: BluetoothRemoteGATTCharacteristic
  notificationSubscriptions: Subscription[]
}

type Subscription = {
  remove: () => void
}

const createWebBluetoothManager = () => {
  const eventEmitter = createEventEmitter()
  const connectedDevices: Record<DeviceId, WebBleDeviceWithMetadata> = {}
  const readBuf = readMessageBuffer()
  const writeHelper = createBleWriteHelper()

  const connectionState = createBleConnectionState(eventEmitter)

  const healthMonitor = createHealthMonitor({
    onStale: (deviceId) => {
      const device = connectedDevices[deviceId]
      if (device) {
        // Trigger a proper OS-level disconnect — this fires the gattserverdisconnected
        // event which runs handleDeviceDisconnected through the normal flow.
        // Calling handleDeviceDisconnected directly would only clean up internal state
        // while leaving the BLE link and characteristic monitors alive.
        device.server.disconnect()
      }
    },
  })

  const onMonitorError = (error: unknown, context: {deviceId: string; characteristic: string}) => {
    console.warn(`[TrezorWebBLE] Monitor error [${context.characteristic}] device=${context.deviceId}`, {
      message: error instanceof Error ? error.message : String(error),
    })
  }

  const monitorCharacteristic = (
    deviceId: string,
    characteristic: BluetoothRemoteGATTCharacteristic,
    name: string,
    callback: (value: DataView) => void,
  ) => {
    const safeCallback = createSafeWebMonitorCallback(deviceId, name, callback, onMonitorError)

    const handler = (event: Event) => {
      const target = event.target as BluetoothRemoteGATTCharacteristic
      if (target.value) {
        safeCallback(target.value)
      }
    }
    characteristic.addEventListener('characteristicvaluechanged', handler)
    characteristic.startNotifications().catch((err) => {
      console.warn(`[TrezorWebBLE] Failed to start notifications [${name}] device=${deviceId}`, err)
    })
    return {
      remove: () => {
        characteristic.removeEventListener('characteristicvaluechanged', handler)
        characteristic.stopNotifications().catch((err) => {
          console.warn(`[TrezorWebBLE] Failed to stop notifications [${name}] device=${deviceId}`, err)
        })
      },
    }
  }

  const attemptToWriteAfterConnect = async (
    deviceId: string,
    writeCharacteristic: BluetoothRemoteGATTCharacteristic,
  ) => {
    const timeoutId = setTimeout(() => {
      connectionState.updateDeviceConnectionStatusChange({
        deviceId,
        connectionStatus: {type: 'pairing'},
      })
    }, 500)

    try {
      const encoder = new TextEncoder()
      await writeCharacteristic.writeValueWithResponse(encoder.encode('Proof of connection'))
    } finally {
      clearTimeout(timeoutId)
    }
  }

  const discoverAndSetupCharacteristics = async (
    device: globalThis.BluetoothDevice,
    server: BluetoothRemoteGATTServer,
  ) => {
    const deviceId = device.id

    const trezorService = await server.getPrimaryService(TrezorService.uuid)
    const batteryServiceObj = await server.getPrimaryService(BatteryService.uuid)

    const writeCharacteristic = await trezorService.getCharacteristic(TrezorService.characteristics.writeUuid)
    const notifyCharacteristic = await trezorService.getCharacteristic(TrezorService.characteristics.notifyUuid)
    const pushCharacteristic = await trezorService.getCharacteristic(TrezorService.characteristics.pushUuid)
    const batteryCharacteristic = await batteryServiceObj.getCharacteristic(
      BatteryService.characteristics.batteryLevelUuid,
    )

    try {
      await attemptToWriteAfterConnect(deviceId, writeCharacteristic)
    } catch (err: unknown) {
      connectionState.updateDeviceConnectionStatusChange({
        deviceId,
        connectionStatus: {type: 'pairing-canceled'},
      })
      server.disconnect()
      throw err
    }

    const notifySub = monitorCharacteristic(deviceId, notifyCharacteristic, 'notify', (value: DataView) => {
      healthMonitor.recordActivity(deviceId)
      readBuf.onMessage(deviceId, new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
    })
    const pushSub = monitorCharacteristic(deviceId, pushCharacteristic, 'push', (value: DataView) => {
      healthMonitor.recordActivity(deviceId)
      connectionState.emitDevicePushNotification({
        deviceId,
        data: Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)),
      })
    })
    const batterySub = monitorCharacteristic(deviceId, batteryCharacteristic, 'battery', (value: DataView) => {
      healthMonitor.recordActivity(deviceId)
      connectionState.emitDeviceBatteryLevelChange({
        deviceId,
        data: Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)),
      })
    })

    connectedDevices[deviceId] = {
      gattDevice: device,
      server,
      writeCharacteristic,
      notificationSubscriptions: [notifySub, pushSub, batterySub],
    }
  }

  const handleDeviceDisconnected = (deviceId: string) => {
    const device = connectedDevices[deviceId]
    if (device) {
      for (const sub of device.notificationSubscriptions) sub.remove()
    }
    readBuf.cancelRead(deviceId)
    writeHelper.clearDevice(deviceId)
    healthMonitor.removeDevice(deviceId)
    delete connectedDevices[deviceId]

    connectionState.updateDeviceConnectionStatusChange({
      deviceId,
      connectionStatus: {type: 'disconnected'},
    })
  }

  return Object.freeze({
    onDeviceConnectionStatusChange: connectionState.onDeviceConnectionStatusChange,
    onDevicePushNotification: connectionState.onDevicePushNotification,
    onDeviceBatteryLevelChange: connectionState.onDeviceBatteryLevelChange,

    /**
     * Request a Trezor device via the Web Bluetooth picker and connect to it.
     *
     * Unlike native BLE which has separate scan + connect steps, Web Bluetooth
     * combines them: `requestDevice()` shows a browser picker, and the user
     * selects the device. We then connect to GATT and set up characteristics.
     */
    connectDevice: async ({
      timeoutMs = 10_000,
      log,
    }: {
      timeoutMs?: number
      log?: (...args: unknown[]) => void
    } = {}): Promise<TrezorBluetoothDevice> => {
      // `console` rather than a wallet logger: this file is web-only glue and must stay importable
      // without `@pnyx/*`. A caller that wants the app's log passes `log`.
      const dbg = log ?? ((...args: unknown[]) => console.debug('[WebBLE]', ...args))

      dbg('[WebBLE] requestDevice: showing picker...')
      const device = await navigator.bluetooth.requestDevice({
        filters: [{services: [TrezorService.uuid]}],
        optionalServices: [BatteryService.uuid],
      })
      dbg('[WebBLE] requestDevice: user selected', device.name, device.id)

      const deviceId = device.id

      connectionState.updateDeviceConnectionStatusChange({
        deviceId,
        connectionStatus: {type: 'connecting'},
      })

      device.addEventListener('gattserverdisconnected', () => {
        handleDeviceDisconnected(deviceId)
      })

      const gatt = device.gatt
      if (!gatt) {
        throw new BluetoothManagerError('DEVICE_NOT_FOUND', 'Device does not support GATT')
      }

      const connectWithTimeout = async (attemptTimeoutMs: number): Promise<BluetoothRemoteGATTServer> => {
        return new Promise<BluetoothRemoteGATTServer>((resolve, reject) => {
          const timer = setTimeout(() => {
            reject(
              new BluetoothManagerError('DEVICE_NOT_FOUND', `GATT connection timed out after ${attemptTimeoutMs}ms`),
            )
          }, attemptTimeoutMs)

          gatt.connect().then(
            (server) => {
              clearTimeout(timer)
              resolve(server)
            },
            (err) => {
              clearTimeout(timer)
              reject(err)
            },
          )
        })
      }

      const maxAttempts = 3
      const perAttemptTimeout = Math.ceil(timeoutMs / maxAttempts)
      let server: BluetoothRemoteGATTServer | undefined
      let lastError: unknown

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        dbg(`[WebBLE] gatt.connect: attempt ${attempt}/${maxAttempts} (timeout ${perAttemptTimeout}ms)`)
        try {
          server = await connectWithTimeout(perAttemptTimeout)
          dbg('[WebBLE] gatt.connect: succeeded on attempt', attempt)
          break
        } catch (err: unknown) {
          lastError = err
          dbg(`[WebBLE] gatt.connect: attempt ${attempt} failed:`, err instanceof Error ? err.message : err)
          if (attempt < maxAttempts) {
            dbg('[WebBLE] gatt.connect: retrying... (check for OS pairing dialog)')
          }
        }
      }

      if (!server) {
        connectionState.updateDeviceConnectionStatusChange({
          deviceId,
          connectionStatus: {
            type: 'connection-error',
            error: lastError instanceof Error ? lastError.message : String(lastError),
          },
        })
        throw new BluetoothManagerError(
          'DEVICE_NOT_FOUND',
          `GATT connection failed after ${maxAttempts} attempts (${timeoutMs}ms total). ` +
            'On Linux, check for a system Bluetooth pairing notification or pre-pair the device via system settings.',
        )
      }

      dbg('[WebBLE] discoverAndSetupCharacteristics: starting...')
      await discoverAndSetupCharacteristics(device, server)
      dbg('[WebBLE] discoverAndSetupCharacteristics: done')

      connectionState.updateDeviceConnectionStatusChange({
        deviceId,
        connectionStatus: {type: 'connected'},
      })

      return {
        id: deviceId,
        name: device.name ?? 'Unknown',
        manufacturerData: [],
        lastUpdatedTimestamp: Date.now(),
        connectionStatus: {type: 'connected'},
      }
    },

    isDeviceConnected: (deviceId: DeviceId): boolean => connectedDevices[deviceId] !== undefined,

    getConnectedDeviceIds: () => Object.keys(connectedDevices),

    disconnectDevice: ({deviceId}: {deviceId: DeviceId}) => {
      const device = connectedDevices[deviceId]
      if (device) {
        device.server.disconnect()
      }
    },

    read: (deviceId: DeviceId, signal?: AbortSignal) => {
      const device = connectedDevices[deviceId]
      if (!device) {
        throw new BluetoothManagerError('DEVICE_NOT_FOUND', 'Device disconnected or not found.')
      }
      return readBuf.read(deviceId, signal)
    },

    cancelRead: (deviceId: DeviceId) => {
      readBuf.cancelRead(deviceId)
    },

    write: async (deviceId: DeviceId, message: Uint8Array) => {
      const device = connectedDevices[deviceId]
      if (!device) {
        throw new BluetoothManagerError('DEVICE_NOT_FOUND', `Device ${deviceId} not found for writing`)
      }

      const padded = await writeHelper.prepareWrite(deviceId, message)

      // writeValueWithResponse ensures the device ACKs each packet at the BLE link
      // layer before we send the next one. writeValueWithoutResponse is faster but
      // the Trezor drops packets that arrive too quickly.
      // Cast needed: prepareWrite returns Uint8Array<ArrayBufferLike> but Web Bluetooth
      // requires BufferSource with ArrayBuffer (no SharedArrayBuffer). The buffer is
      // always a plain ArrayBuffer in practice.
      await device.writeCharacteristic.writeValueWithResponse(padded as Uint8Array<ArrayBuffer>)
      healthMonitor.recordActivity(deviceId)
    },
  })
}

export const webBluetoothManager = createWebBluetoothManager()
