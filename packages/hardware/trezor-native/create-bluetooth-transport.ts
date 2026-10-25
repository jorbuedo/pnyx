/**
 * Native Bluetooth transport factory for Trezor on Android/iOS.
 *
 * Replaces the NativeBluetoothTransport class with a factory function.
 * Uses `react-native-ble-plx` via the bluetooth manager for BLE communication.
 */

import {createBluetoothDeviceApi} from './bluetooth/bluetooth-device-api'
import {createTransportAdapter} from './transport/adapter'
import type {TransportParams} from './transport/types'

export const createNativeBluetoothTransport = (params: TransportParams = {}) => {
  const api = createBluetoothDeviceApi({logger: params.logger})

  const transport = createTransportAdapter({
    name: 'NativeBluetoothTransport',
    api,
    logger: params.logger,
    messages: params.messages,
    id: params.id,
  })

  // Forward push notification and battery events from api to transport
  api.on('trezor-push-notification', (...args: unknown[]) => transport.emit('trezor-push-notification', ...args))
  api.on('battery-level', (...args: unknown[]) => transport.emit('battery-level', ...args))

  return transport
}
