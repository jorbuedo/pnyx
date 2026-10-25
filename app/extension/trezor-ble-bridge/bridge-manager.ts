/**
 * Background-side Trezor BLE bridge lifecycle management.
 *
 * Manages the bridge tab that hosts the Web Bluetooth connection: opens/reuses
 * tabs, relays raw read/write operations over a chrome.runtime port, and handles
 * keepalive + disconnect detection. Uses the shared `createBridgeManager` for
 * infrastructure and adds Trezor-specific read/write/enumerate operations.
 *
 * @module
 */

import {
  TREZOR_BLE_BRIDGE_PORT_NAME,
  TREZOR_BLE_OPEN_TIMEOUT,
  TREZOR_BLE_PING_INTERVAL,
  TREZOR_BLE_PING_TIMEOUT,
  TREZOR_BLE_READ_TIMEOUT,
  type TrezorBLEBridgeRequest,
} from '../../src/platform/extension/protocol/trezor'
import type {BridgeState} from '../ble-bridge-core'
import {createBridgeManager} from '../ble-bridge-core'

const bridge = createBridgeManager({
  portName: TREZOR_BLE_BRIDGE_PORT_NAME,
  htmlFileName: 'ble-bridge.html?device=trezor',
  deviceLabel: 'Trezor BLE',
  openTimeout: TREZOR_BLE_OPEN_TIMEOUT,
  pingInterval: TREZOR_BLE_PING_INTERVAL,
  pingTimeout: TREZOR_BLE_PING_TIMEOUT,
  pingType: 'TREZOR_BLE_PING',
  pongType: 'TREZOR_BLE_PONG',
  disconnectType: 'TREZOR_BLE_DISCONNECTED',
  errorTypes: ['TREZOR_BLE_ERROR'],
})

export type TrezorBLEBridgeState = BridgeState

/**
 * Initialize listeners for the Trezor BLE bridge port connection and tab removal.
 * Must be called synchronously at module level in background.ts.
 */
export const initTrezorBLEBridgeListeners = bridge.initListeners

/** Get current bridge state. */
export const getTrezorBLEBridgeState = bridge.getState

/** Register a listener for Trezor BLE disconnect events. */
export const onTrezorBLEBridgeDisconnect = bridge.onDisconnect

export const connectTrezorBLE = async (): Promise<{deviceId: string; deviceName: string}> => {
  await bridge.openBridge()

  bridge.postMessage({type: 'TREZOR_BLE_CONNECT'} satisfies TrezorBLEBridgeRequest)
  const response = await bridge.waitForResponse('TREZOR_BLE_CONNECTED', TREZOR_BLE_OPEN_TIMEOUT)
  bridge.setState('connected')
  return {deviceId: response.deviceId as string, deviceName: response.deviceName as string}
}

export const enumerateTrezorBLE = async (): Promise<
  Array<{path: string; type: number; id: string; apiType: string}>
> => {
  bridge.postMessage({type: 'TREZOR_BLE_ENUMERATE'} satisfies TrezorBLEBridgeRequest)
  const response = await bridge.waitForResponse('TREZOR_BLE_ENUMERATE_RESULT', 5_000)
  return response.descriptors as Array<{path: string; type: number; id: string; apiType: string}>
}

export const readTrezorBLE = async (requestId: string, path: string): Promise<string> => {
  bridge.postMessage({type: 'TREZOR_BLE_READ', requestId, path} satisfies TrezorBLEBridgeRequest)
  const response = await bridge.waitForRequestIdResponse('TREZOR_BLE_READ_RESULT', requestId, TREZOR_BLE_READ_TIMEOUT)
  return response.dataHex as string
}

export const cancelReadTrezorBLE = (path: string): void => {
  const port = bridge.getPort()
  if (!port) return
  port.postMessage({type: 'TREZOR_BLE_CANCEL_READ', path} satisfies TrezorBLEBridgeRequest)
}

export const writeTrezorBLE = async (requestId: string, path: string, dataHex: string): Promise<void> => {
  bridge.postMessage({type: 'TREZOR_BLE_WRITE', requestId, path, dataHex} satisfies TrezorBLEBridgeRequest)
  await bridge.waitForRequestIdResponse('TREZOR_BLE_WRITE_RESULT', requestId, TREZOR_BLE_READ_TIMEOUT)
}

export const openDeviceTrezorBLE = async (path: string, channel?: string): Promise<void> => {
  bridge.postMessage({
    type: 'TREZOR_BLE_OPEN_DEVICE',
    path,
    ...(channel !== undefined ? {channel} : {}),
  } satisfies TrezorBLEBridgeRequest)
  await bridge.waitForResponse('TREZOR_BLE_OPEN_DEVICE_RESULT', 5_000)
}

export const closeDeviceTrezorBLE = async (path: string, channel?: string): Promise<void> => {
  bridge.postMessage({
    type: 'TREZOR_BLE_CLOSE_DEVICE',
    path,
    ...(channel !== undefined ? {channel} : {}),
  } satisfies TrezorBLEBridgeRequest)
}

export const closeTrezorBLETransport = () => bridge.closeTransport('TREZOR_BLE_CLOSE', 'TREZOR_BLE_CLOSED')

export const closeTrezorBLEBridge = async (): Promise<void> => {
  await closeTrezorBLETransport()
  await bridge.closeBridge()
}
