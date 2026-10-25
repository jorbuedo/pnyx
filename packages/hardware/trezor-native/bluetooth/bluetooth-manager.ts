/**
 * Bluetooth manager for Trezor BLE transport.
 *
 * Vendored from @trezor/transport-native-bluetooth (trezor-suite, unpublished).
 * Manages BLE scanning, connection, and data transfer for Trezor devices.
 */

import {getLogger} from '@pnyx/logger'
import type {BleError, Characteristic, ConnectionOptions, Device, Subscription} from 'react-native-ble-plx'
import {BleErrorCode, BleManager, State} from 'react-native-ble-plx'
import {createBleConnectionState} from '../../trezor-protocol/ble/connection-state'
import {BatteryService, TrezorService} from '../../trezor-protocol/ble/constants'
import {createHealthMonitor} from '../../trezor-protocol/ble/health-monitor'
import {classifyBleConnectionError} from '../../trezor-protocol/ble/ios-errors'
import {createSafeNativeMonitorCallback} from '../../trezor-protocol/ble/monitor-wrapper'
import {BluetoothManagerError} from '../../trezor-protocol/ble/types'
import {createBleWriteHelper} from '../../trezor-protocol/ble/write-helper'
import {base64ToBytes, bytesToBase64, utf8ToBytes} from '../../trezor-protocol/bytes'
import {readMessageBuffer} from '../../trezor-protocol/utils'
import {createEventEmitter} from '../event-emitter'
import {base64ToByteArray, toBluetoothDevice} from './utils'

const logger = getLogger('hardware')

type DeviceId = string

type BleDeviceWithMetadata = {
  bleDevice: Device
  writeCharacteristic: Characteristic
}

const createBluetoothManager = () => {
  let bleManager: BleManager | null = null
  const eventEmitter = createEventEmitter()
  let nearbyDevicesRemovalId: ReturnType<typeof setTimeout> | null = null
  const connectedDevices: Record<DeviceId, BleDeviceWithMetadata> = {}
  const readBuf = readMessageBuffer()
  const writeHelper = createBleWriteHelper()

  const connectionState = createBleConnectionState(eventEmitter, {trackNearbyDevices: true})

  const healthMonitor = createHealthMonitor({
    onStale: (deviceId) => {
      const device = connectedDevices[deviceId]
      if (device) {
        // Trigger a proper OS-level disconnect — this fires the onDeviceDisconnected
        // callback which runs handleDeviceDisconnected through the normal flow.
        // Calling handleDeviceDisconnected directly would only clean up internal state
        // while leaving the BLE link and characteristic monitors alive.
        device.bleDevice.cancelConnection().catch((err) => {
          console.warn(`[TrezorBLE] Failed to cancel stale connection device=${deviceId}`, err)
        })
      }
    },
  })

  const onMonitorError = (error: unknown, context: {deviceId: string; characteristic: string}) => {
    // Log with as much detail as available for debugging BLE issues
    const bleError = error as {errorCode?: number; iosErrorCode?: number; reason?: string; message?: string}
    console.warn(`[TrezorBLE] Monitor error [${context.characteristic}] device=${context.deviceId}`, {
      errorCode: bleError.errorCode,
      iosErrorCode: bleError.iosErrorCode,
      reason: bleError.reason,
      message: bleError.message ?? String(error),
    })
  }

  let bleManagerReady = false

  const getBleManager = (): BleManager => {
    // Deferred init ensures Bluetooth permission is not auto-requested at iOS app startup.
    // BleManager is a singleton — second `new BleManager()` returns the same instance.
    if (bleManager === null) {
      bleManager = new BleManager()
    }
    return bleManager
  }

  /**
   * Wait for BLE adapter to reach PoweredOn state.
   *
   * Mirrors Ledger's `awaitsBleOn` flow:
   * 1. Create BleManager (triggers iOS permission dialog if first time)
   * 2. Subscribe to onStateChange
   * 3. Wait for PoweredOn — only then is it safe to call scan/connect
   *
   * This avoids calling void native methods (startDeviceScan etc.) while
   * CBCentralManager is still initializing, which crashes under TurboModules.
   */
  const waitForPoweredOn = (timeoutMs = 15_000): Promise<void> => {
    if (bleManagerReady) return Promise.resolve()

    const manager = getBleManager()

    return new Promise((resolve, reject) => {
      let done = false

      const timeout = setTimeout(() => {
        if (done) return
        done = true
        sub.remove()
        reject(new Error('Bluetooth adapter did not reach PoweredOn state within timeout. Is Bluetooth enabled?'))
      }, timeoutMs)

      const sub = manager.onStateChange((state) => {
        if (done) return

        if (state === State.PoweredOn) {
          done = true
          clearTimeout(timeout)
          sub.remove()
          bleManagerReady = true
          resolve()
        } else if (state === State.Unauthorized) {
          done = true
          clearTimeout(timeout)
          sub.remove()
          reject(new Error('Bluetooth permission not granted. Please enable Bluetooth access in Settings.'))
        } else if (state === State.Unsupported) {
          done = true
          clearTimeout(timeout)
          sub.remove()
          reject(new Error('Bluetooth is not supported on this device.'))
        }
        // Unknown / Resetting / PoweredOff — keep waiting (permission dialog may be showing)
      }, true) // true = emit current state immediately
    })
  }

  const removeStaleNearbyDevices = () => {
    nearbyDevicesRemovalId = setTimeout(removeStaleNearbyDevices, 1000)
    connectionState.removeStaleDevices(3_000)
  }

  const startStaleNearbyDevicesRemoval = () => {
    if (!nearbyDevicesRemovalId) {
      removeStaleNearbyDevices()
    }
  }

  const stopStaleNearbyDevicesRemoval = () => {
    if (nearbyDevicesRemovalId) {
      clearTimeout(nearbyDevicesRemovalId)
      nearbyDevicesRemovalId = null
    }
  }

  const handleConnectionError = (deviceId: DeviceId, err: unknown) => {
    const bleError = err as {iosErrorCode?: number; reason?: string; message?: string}
    const classification = classifyBleConnectionError(bleError)
    const errorMessage = bleError.message ?? 'Unknown error'

    console.warn(`[TrezorBLE] Connection error device=${deviceId} classification=${classification}`, {
      iosErrorCode: bleError.iosErrorCode,
      reason: bleError.reason,
      message: errorMessage,
    })

    if (classification === 'pairing-error') {
      connectionState.updateDeviceConnectionStatusChange({
        deviceId,
        connectionStatus: {type: 'pairing-error', error: errorMessage},
      })
    } else {
      connectionState.updateDeviceConnectionStatusChange({
        deviceId,
        connectionStatus: {type: 'connection-error', error: errorMessage},
      })
    }
  }

  const monitorCharacteristic = (
    deviceId: DeviceId,
    characteristicToMonitor: Characteristic,
    name: 'notify' | 'push' | 'battery',
    callback: (value: string) => void,
  ) =>
    characteristicToMonitor.monitor(
      createSafeNativeMonitorCallback(
        deviceId,
        name,
        (characteristic: Characteristic) => {
          if (characteristic.value) {
            callback(characteristic.value)
          }
        },
        onMonitorError,
      ),
    )

  const attemptToWriteAfterConnect = async (device: Device, writeCharacteristic: Characteristic) => {
    const timeoutId = setTimeout(() => {
      connectionState.updateDeviceConnectionStatusChange({
        deviceId: device.id,
        connectionStatus: {type: 'pairing'},
      })
    }, 500)

    try {
      await writeCharacteristic.writeWithResponse(bytesToBase64(utf8ToBytes('Proof of connection')))
    } finally {
      clearTimeout(timeoutId)
    }
  }

  const discoverAndTestCharacteristics = async (device: Device) => {
    await device.discoverAllServicesAndCharacteristics()

    const trezorCharacteristics = await device.characteristicsForService(TrezorService.uuid)

    // Battery service is optional — some firmware versions or BLE reconnections
    // may not expose it. Crashing here would prevent connection entirely.
    let batteryCharacteristics: Characteristic[] = []
    try {
      batteryCharacteristics = await device.characteristicsForService(BatteryService.uuid)
    } catch (e: unknown) {
      // Battery service not available — non-fatal, and the ordinary case on models that do not
      // expose it. A real GATT failure takes the same branch.
      logger.debug(`bluetooth: battery characteristics unavailable: ${String(e)}`)
    }

    let writeCharacteristic: Characteristic | undefined
    let notifyCharacteristic: Characteristic | undefined
    let pushCharacteristic: Characteristic | undefined
    let batteryCharacteristic: Characteristic | undefined

    for (const characteristic of trezorCharacteristics) {
      if (characteristic.uuid === TrezorService.characteristics.writeUuid) {
        writeCharacteristic = characteristic
      } else if (characteristic.uuid === TrezorService.characteristics.notifyUuid) {
        notifyCharacteristic = characteristic
      } else if (characteristic.uuid === TrezorService.characteristics.pushUuid) {
        pushCharacteristic = characteristic
      }
    }
    for (const characteristic of batteryCharacteristics) {
      if (characteristic.uuid === BatteryService.characteristics.batteryLevelUuid) {
        batteryCharacteristic = characteristic
      }
    }

    if (!writeCharacteristic)
      throw new BluetoothManagerError('CHARACTERISTIC_NOT_FOUND', 'Write characteristic not found.')
    if (!notifyCharacteristic)
      throw new BluetoothManagerError('CHARACTERISTIC_NOT_FOUND', 'Notify characteristic not found.')
    if (!pushCharacteristic)
      throw new BluetoothManagerError('CHARACTERISTIC_NOT_FOUND', 'Push characteristic not found.')

    try {
      await attemptToWriteAfterConnect(device, writeCharacteristic)
    } catch (err: unknown) {
      connectionState.updateDeviceConnectionStatusChange({
        deviceId: device.id,
        connectionStatus: {type: 'pairing-canceled'},
      })
      await device.cancelConnection()
      throw err
    }

    monitorCharacteristic(device.id, notifyCharacteristic, 'notify', (value: string) => {
      healthMonitor.recordActivity(device.id)
      readBuf.onMessage(device.id, base64ToBytes(value))
    })
    monitorCharacteristic(device.id, pushCharacteristic, 'push', (value: string) => {
      healthMonitor.recordActivity(device.id)
      connectionState.emitDevicePushNotification({
        deviceId: device.id,
        data: base64ToByteArray(value),
      })
    })
    if (batteryCharacteristic) {
      monitorCharacteristic(device.id, batteryCharacteristic, 'battery', (value: string) => {
        healthMonitor.recordActivity(device.id)
        connectionState.emitDeviceBatteryLevelChange({
          deviceId: device.id,
          data: base64ToByteArray(value),
        })
      })
    }

    connectedDevices[device.id] = {
      bleDevice: device,
      writeCharacteristic,
    }
  }

  const handleDeviceDisconnected = (disconnectError: BleError | null, device: Device | null) => {
    if (device) {
      if (disconnectError) {
        const bleError = disconnectError as unknown as {
          errorCode?: number
          iosErrorCode?: number
          reason?: string
          message?: string
        }
        console.warn(`[TrezorBLE] Device disconnected with error device=${device.id}`, {
          errorCode: bleError.errorCode,
          iosErrorCode: bleError.iosErrorCode,
          reason: bleError.reason,
          message: bleError.message,
        })
      }

      readBuf.cancelRead(device.id)
      writeHelper.clearDevice(device.id)
      healthMonitor.removeDevice(device.id)
      connectionState.removeNearbyDevice(device.id)
      delete connectedDevices[device.id]

      connectionState.emitNearbyDevicesChange()
      connectionState.updateDeviceConnectionStatusChange({
        deviceId: device.id,
        connectionStatus: {type: 'disconnected'},
      })
    }
  }

  return Object.freeze({
    /**
     * Adopt an externally-owned BleManager so the whole app shares ONE native
     * client. react-native-ble-plx managers are NOT singletons — two `new
     * BleManager()`s are two clients that contend for the adapter, so a
     * peripheral discovered by one can't be connected by the other. Must be
     * called before any scan/connect (i.e. before we'd lazily create our own).
     */
    setBleManager: (manager: BleManager): boolean => {
      if (bleManager === null) {
        bleManager = manager
        return true
      }
      return bleManager === manager
    },

    onAdapterStatusChange: (listener: (state: State) => void): Subscription =>
      getBleManager().onStateChange(listener, true),

    onNearbyDevicesChange: connectionState.onNearbyDevicesChange,
    onDeviceConnectionStatusChange: connectionState.onDeviceConnectionStatusChange,
    onDevicePushNotification: connectionState.onDevicePushNotification,
    onDeviceBatteryLevelChange: connectionState.onDeviceBatteryLevelChange,

    waitForPoweredOn,

    startDeviceScan: (errorHandler?: (scanError: BleError) => void) => {
      getBleManager().startDeviceScan([TrezorService.uuid], {allowDuplicates: true}, (scanError, scannedDevice) => {
        if (scanError) {
          stopStaleNearbyDevicesRemoval()
          errorHandler?.(scanError)
        }
        if (scannedDevice) {
          const nearbyDevice = toBluetoothDevice(scannedDevice)
          const changed = connectionState.addOrUpdateNearbyDevice(nearbyDevice)
          if (changed) connectionState.emitNearbyDevicesChange()
        }
      })
      startStaleNearbyDevicesRemoval()
    },

    stopDeviceScan: () => {
      stopStaleNearbyDevicesRemoval()
      getBleManager().stopDeviceScan()
    },

    isDeviceConnected: (deviceId: DeviceId): boolean => connectedDevices[deviceId] !== undefined,

    getConnectedDeviceIds: () => Object.keys(connectedDevices),

    connectDevice: async ({deviceId, timeoutMs = 5_000}: {deviceId: DeviceId; timeoutMs?: number}): Promise<Device> => {
      const connectionOptions: ConnectionOptions = {
        requestMTU: 247,
        timeout: timeoutMs,
      }

      const attemptConnect = async (): Promise<Device> => {
        connectionState.updateDeviceConnectionStatusChange({
          deviceId,
          connectionStatus: {type: 'connecting'},
        })

        let device: Device | undefined

        const devices = await getBleManager().devices([deviceId])
        ;[device] = devices

        if (!device) {
          const connected = await getBleManager().connectedDevices([TrezorService.uuid])
          const matching = connected.filter((d) => d.id === deviceId)
          ;[device] = matching
        }

        if (!device) {
          try {
            device = await getBleManager().connectToDevice(deviceId, connectionOptions)
          } catch (connectErr: unknown) {
            const bleError = connectErr as {errorCode?: number; message?: string}
            if (bleError.errorCode === BleErrorCode.DeviceMTUChangeFailed) {
              device = await getBleManager().connectToDevice(deviceId)
            } else {
              throw connectErr
            }
          }
        }

        if (!device) {
          throw new BluetoothManagerError('DEVICE_NOT_FOUND', `Cannot find device ${deviceId}`)
        }

        if (!(await device.isConnected())) {
          try {
            await device.connect(connectionOptions)
          } catch (connectErr: unknown) {
            const bleError = connectErr as {errorCode?: number}
            if (bleError.errorCode === BleErrorCode.DeviceMTUChangeFailed) {
              await device.connect()
            } else {
              throw connectErr
            }
          }
        }

        await discoverAndTestCharacteristics(device)

        getBleManager().onDeviceDisconnected(device.id, handleDeviceDisconnected)

        connectionState.updateDeviceConnectionStatusChange({
          deviceId: device.id,
          connectionStatus: {type: 'connected'},
        })

        return device
      }

      // A first-time / re-paired Trezor Safe triggers OS bonding during service
      // discovery on Android; the OS cancels the in-flight GATT op with
      // `OperationCancelled` while it bonds in the background. Retry after a
      // short backoff — once the bond has settled the same call succeeds. We do
      // NOT drop the link between tries: if it's still up we just re-run
      // discovery (now bonded); if it dropped, `attemptConnect` reconnects.
      const MAX_ATTEMPTS = 4
      const BONDING_BACKOFF_MS = 1_500

      let lastError: unknown
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          return await attemptConnect()
        } catch (err: unknown) {
          lastError = err
          const cancelled = (err as {errorCode?: number} | null)?.errorCode === BleErrorCode.OperationCancelled
          if (!cancelled || attempt === MAX_ATTEMPTS) {
            handleConnectionError(deviceId, err)
            throw err
          }
          console.warn(
            `[TrezorBLE] connect cancelled (OS bonding in progress), retry ${attempt}/${MAX_ATTEMPTS - 1} device=${deviceId}`,
          )
          await new Promise((resolve) => setTimeout(resolve, BONDING_BACKOFF_MS))
        }
      }

      // Loop always returns or throws above; this satisfies the type checker.
      throw lastError
    },

    disconnectDevice: ({deviceId}: {deviceId: DeviceId}) => {
      const device = connectedDevices[deviceId]
      if (device) {
        return device.bleDevice.cancelConnection()
      }
      return undefined
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

      // writeWithResponse ensures the device ACKs each packet at the BLE link
      // layer before we send the next one. writeWithoutResponse is faster but
      // the Trezor drops packets that arrive too quickly.
      await device.writeCharacteristic.writeWithResponse(bytesToBase64(padded))
      healthMonitor.recordActivity(deviceId)
    },
  })
}

export const bluetoothManager = createBluetoothManager()
