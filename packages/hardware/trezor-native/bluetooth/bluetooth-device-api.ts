/**
 * Bluetooth device API for Trezor BLE transport.
 *
 * Thin wrapper that binds the shared BLE device API factory
 * to the native bluetooth manager singleton.
 */

import {createBleDeviceApi} from '../../trezor-protocol/ble/create-ble-device-api'
import type {DeviceApi, Logger} from '../transport/types'
import {bluetoothManager} from './bluetooth-manager'

export const createBluetoothDeviceApi = (params: {logger?: Logger | undefined}): DeviceApi =>
  createBleDeviceApi(bluetoothManager, params)
