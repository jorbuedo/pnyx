/**
 * WebUSB-compatible interface factory for React Native.
 *
 * Replaces the WebUSB class from react-native-usb with a factory function.
 * Uses the standalone functions from the native module (Android) or returns
 * stubs for unsupported platforms (iOS).
 */

import {Platform} from 'react-native'
import {getDevices, onDeviceConnected, onDeviceDisconnect} from '../react-native-usb/src/index'
import type {OnConnectEvent} from '../react-native-usb/src/ReactNativeUsb.types'

/**
 * WebUSB-compatible interface for @trezor/transport's UsbApi.
 */
export type WebUSBInterface = {
  getDevices: typeof getDevices
  onconnect: ((event: OnConnectEvent) => void) | null
  ondisconnect: ((event: OnConnectEvent) => void) | null
  requestDevice: (...params: unknown[]) => Promise<unknown>
  addEventListener: (...params: unknown[]) => unknown
  removeEventListener: (...params: unknown[]) => unknown
  dispatchEvent: (...params: unknown[]) => unknown
}

const createIOSStub = (): WebUSBInterface => ({
  getDevices: async () => [],
  onconnect: null,
  ondisconnect: null,
  requestDevice: async () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => {},
})

const createAndroidWebUSB = (): WebUSBInterface => {
  const iface: WebUSBInterface = {
    getDevices,
    onconnect: null,
    ondisconnect: null,
    requestDevice: async () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => {},
  }

  // Use Object.defineProperty to wire up setters that register native listeners
  const result = Object.create(null)
  Object.assign(result, iface)

  let connectSub: {remove: () => void} | null = null
  let disconnectSub: {remove: () => void} | null = null

  Object.defineProperty(result, 'onconnect', {
    set(listener: ((event: OnConnectEvent) => void) | null) {
      connectSub?.remove()
      if (listener) {
        connectSub = onDeviceConnected(listener)
      } else {
        connectSub = null
      }
    },
    get() {
      return connectSub ? true : null
    },
    configurable: true,
    enumerable: true,
  })

  Object.defineProperty(result, 'ondisconnect', {
    set(listener: ((event: OnConnectEvent) => void) | null) {
      disconnectSub?.remove()
      if (listener) {
        disconnectSub = onDeviceDisconnect(listener)
      } else {
        disconnectSub = null
      }
    },
    get() {
      return disconnectSub ? true : null
    },
    configurable: true,
    enumerable: true,
  })

  return result as WebUSBInterface
}

export const createWebUSB = (): WebUSBInterface => (Platform.OS === 'ios' ? createIOSStub() : createAndroidWebUSB())
