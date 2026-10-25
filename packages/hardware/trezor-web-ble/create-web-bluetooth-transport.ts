/**
 * Web Bluetooth transport factory for Trezor in browser contexts.
 *
 * Creates a duck-typed transport for injection into `@trezor/connect`'s `init()`.
 * Only works where navigator.bluetooth is available (fullscreen browser tabs).
 */

import {createTransportAdapter} from '../trezor-native/transport/adapter'
import type {TransportParams} from '../trezor-native/transport/types'
import {createWebBluetoothDeviceApi} from './web-bluetooth-device-api'

export const createWebBluetoothTransport = (params: TransportParams = {}) => {
  const api = createWebBluetoothDeviceApi({logger: params.logger})

  const transport = createTransportAdapter({
    name: 'WebBluetoothTransport',
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
