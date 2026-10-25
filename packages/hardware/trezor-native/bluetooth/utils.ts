/**
 * Bluetooth utility functions for Trezor BLE transport.
 *
 * Vendored from @trezor/transport-native-bluetooth (trezor-suite, unpublished).
 */

import type {Device} from 'react-native-ble-plx'
import {base64ToBytes} from '../../trezor-protocol/bytes'

import type {BluetoothDevice} from './types'

export const base64ToByteArray = (value: string) => Array.from(base64ToBytes(value))

export const toBluetoothDevice = (device: Device): BluetoothDevice => ({
  id: device.id,
  name: device.name ?? 'Unknown',
  // @suite-common utils expect the Bluetooth company identifier (first two bytes) to be trimmed
  manufacturerData: base64ToByteArray(device.manufacturerData ?? '').slice(2),
  lastUpdatedTimestamp: Date.now(),
  connectionStatus: {type: 'disconnected'},
})
