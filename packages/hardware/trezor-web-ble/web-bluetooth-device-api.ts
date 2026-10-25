/**
 * Web Bluetooth device API for Trezor BLE transport.
 *
 * Thin wrapper that binds the shared BLE device API factory
 * to the web bluetooth manager singleton.
 */

import type {DeviceApi, Logger} from '../trezor-native/transport/types'
import {createBleDeviceApi} from '../trezor-protocol/ble/create-ble-device-api'
import {webBluetoothManager} from './web-bluetooth-manager'

export const createWebBluetoothDeviceApi = (params: {logger?: Logger | undefined}): DeviceApi =>
  createBleDeviceApi(webBluetoothManager, params)
