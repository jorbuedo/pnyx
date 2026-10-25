/**
 * Trezor BLE bridge transport for the browser extension sidepanel.
 *
 * DORMANT (see `../runtime` and `docs/EXTENSION.md`), and currently unwired even
 * within the extension client — kept as the reference implementation for the
 * Trezor half of a future hardware-only extension. Creates a DeviceApi-compatible
 * object that relays read/write operations through extension messaging to the
 * Trezor BLE bridge tab, which runs in a fullscreen browser tab where
 * `navigator.bluetooth` is available. App-bundle (Metro) client half, NOT the
 * extension background bundle.
 *
 * @module
 */

import {logger} from '../../../logger'
import type {TrezorBLEBridgeExtensionMessage, TrezorBLEBridgeExtensionResponse} from '../protocol/trezor'
import {sendMessage} from '../runtime'

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

const hexToBytes = (hex: string): Uint8Array => {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16)
  }
  return bytes
}

let requestCounter = 0

const nextRequestId = () => `trezor-ble-${++requestCounter}-${Date.now()}`

const sendBridgeMessage = async <T extends TrezorBLEBridgeExtensionResponse>(
  message: TrezorBLEBridgeExtensionMessage,
): Promise<T> => {
  const response = await sendMessage<
    {type: 'SUCCESS'; payload: TrezorBLEBridgeExtensionResponse} | {type: 'ERROR'; payload: {message: string}}
  >(message)
  if (!response || !('type' in response)) {
    throw new Error('Trezor BLE bridge: no response received')
  }
  if (response.type === 'ERROR') {
    throw new Error(response.payload.message)
  }
  const inner = response.payload
  if (inner.type === 'TREZOR_BLE_BRIDGE_ERROR') {
    throw new Error(inner.message)
  }
  return inner as T
}

type EventListeners = Record<string, Array<(...args: unknown[]) => void>>

/**
 * Connect to a Trezor via the BLE bridge tab.
 * Returns device info after the user picks a device in the bridge tab.
 */
export const connectTrezorViaBridge = async (): Promise<{deviceId: string; deviceName: string}> => {
  const result = await sendBridgeMessage<
    Extract<TrezorBLEBridgeExtensionResponse, {type: 'TREZOR_BLE_BRIDGE_CONNECTED'}>
  >({type: 'TREZOR_BLE_BRIDGE_CONNECT'})
  return {deviceId: result.deviceId, deviceName: result.deviceName}
}

/**
 * Create a DeviceApi that relays all operations through the Trezor BLE bridge.
 *
 * Plug this into `createTransportAdapter({api: ...})` to get a fully functional
 * transport adapter that works in extension sidepanel contexts.
 */
export const createTrezorBLEBridgeDeviceApi = () => {
  const listeners: EventListeners = {}

  const on = (event: string, listener: (...args: unknown[]) => void) => {
    if (!listeners[event]) listeners[event] = []
    listeners[event].push(listener)
  }

  const off = (event: string, listener: (...args: unknown[]) => void) => {
    const arr = listeners[event]
    if (!arr) return
    const idx = arr.indexOf(listener)
    if (idx >= 0) arr.splice(idx, 1)
  }

  const once = (event: string, listener: (...args: unknown[]) => void) => {
    const wrapper = (...args: unknown[]) => {
      off(event, wrapper)
      listener(...args)
    }
    on(event, wrapper)
  }

  const emit = (event: string, ...args: unknown[]) => {
    const arr = listeners[event]
    if (!arr) return
    for (const fn of [...arr]) fn(...args)
  }

  const enumerate = async () => {
    try {
      const result = await sendBridgeMessage<
        Extract<TrezorBLEBridgeExtensionResponse, {type: 'TREZOR_BLE_BRIDGE_ENUMERATE_RESULT'}>
      >({type: 'TREZOR_BLE_BRIDGE_ENUMERATE'})
      return {success: true as const, payload: result.descriptors}
    } catch (err) {
      return {success: false as const, error: 'unexpected error' as const, message: String(err)}
    }
  }

  const read = async (path: string, signal?: AbortSignal) => {
    if (signal?.aborted) {
      return {success: false as const, error: 'interface data transfer error' as const, message: 'Aborted'}
    }
    const onAbort = () => {
      sendBridgeMessage({type: 'TREZOR_BLE_BRIDGE_CANCEL_READ', path}).catch((e) => {
        logger.warn('Failed to cancel a Trezor BLE read; the bridge may keep reading', {
          origin: 'trezor-ble-bridge',
          error: String(e),
        })
      })
    }
    signal?.addEventListener('abort', onAbort)
    try {
      const requestId = nextRequestId()
      const result = await sendBridgeMessage<
        Extract<TrezorBLEBridgeExtensionResponse, {type: 'TREZOR_BLE_BRIDGE_READ_RESULT'}>
      >({type: 'TREZOR_BLE_BRIDGE_READ', requestId, path})
      return {success: true as const, payload: hexToBytes(result.dataHex)}
    } catch (err) {
      return {success: false as const, error: 'interface data transfer error' as const, message: String(err)}
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
  }

  const write = async (path: string, buffer: Uint8Array, signal?: AbortSignal) => {
    if (signal?.aborted) {
      return {success: false as const, error: 'interface data transfer error' as const, message: 'Aborted'}
    }
    try {
      const requestId = nextRequestId()
      await sendBridgeMessage<Extract<TrezorBLEBridgeExtensionResponse, {type: 'TREZOR_BLE_BRIDGE_WRITE_RESULT'}>>({
        type: 'TREZOR_BLE_BRIDGE_WRITE',
        requestId,
        path,
        dataHex: bytesToHex(buffer),
      })
      return {success: true as const, payload: undefined}
    } catch (err) {
      return {success: false as const, error: 'interface data transfer error' as const, message: String(err)}
    }
  }

  const openDevice = async (path: string, options?: {channel?: string}) => {
    try {
      await sendBridgeMessage<
        Extract<TrezorBLEBridgeExtensionResponse, {type: 'TREZOR_BLE_BRIDGE_OPEN_DEVICE_RESULT'}>
      >({type: 'TREZOR_BLE_BRIDGE_OPEN_DEVICE', path, ...(options?.channel != null && {channel: options.channel})})
      return {success: true as const, payload: undefined}
    } catch (err) {
      return {success: false as const, error: 'interface data transfer error' as const, message: String(err)}
    }
  }

  const closeDevice = async (path: string, options?: {channel?: string}) => {
    try {
      await sendBridgeMessage<
        Extract<TrezorBLEBridgeExtensionResponse, {type: 'TREZOR_BLE_BRIDGE_CLOSE_DEVICE_RESULT'}>
      >({type: 'TREZOR_BLE_BRIDGE_CLOSE_DEVICE', path, ...(options?.channel != null && {channel: options.channel})})
      return {success: true as const, payload: undefined}
    } catch (err) {
      return {success: false as const, error: 'interface data transfer error' as const, message: String(err)}
    }
  }

  return {
    type: 'bluetooth' as const,
    chunkSize: 244,
    enumerate,
    listen: () => {},
    read,
    write,
    openDevice,
    closeDevice,
    dispose: () => {},
    on,
    off,
    once,
    emit,
  }
}
