/**
 * Background-side Ledger BLE bridge lifecycle management.
 *
 * Manages the bridge tab that hosts the Web Bluetooth connection: opens/reuses
 * tabs, relays APDU commands over a chrome.runtime port, and handles keepalive +
 * disconnect detection. Uses the shared `createBridgeManager` for infrastructure
 * and adds Ledger-specific APDU operations on top.
 *
 * @module
 */

import {
  LEDGER_BLE_BRIDGE_PORT_NAME,
  LEDGER_BLE_EXCHANGE_TIMEOUT,
  LEDGER_BLE_OPEN_TIMEOUT,
  LEDGER_BLE_PING_INTERVAL,
  LEDGER_BLE_PING_TIMEOUT,
  type LedgerBLEBridgeRequest,
} from '../../src/platform/extension/protocol/ledger'
import type {BridgeState} from '../ble-bridge-core'
import {createBridgeManager} from '../ble-bridge-core'

const bridge = createBridgeManager({
  portName: LEDGER_BLE_BRIDGE_PORT_NAME,
  htmlFileName: 'ble-bridge.html?device=ledger',
  deviceLabel: 'Ledger BLE',
  openTimeout: LEDGER_BLE_OPEN_TIMEOUT,
  pingInterval: LEDGER_BLE_PING_INTERVAL,
  pingTimeout: LEDGER_BLE_PING_TIMEOUT,
  pingType: 'LEDGER_BLE_PING',
  pongType: 'LEDGER_BLE_PONG',
  disconnectType: 'LEDGER_BLE_DISCONNECTED',
  errorTypes: ['LEDGER_BLE_ERROR', 'LEDGER_BLE_SEND_ERROR'],
})

export type LedgerBLEBridgeState = BridgeState

/**
 * Initialize listeners for the Ledger BLE bridge port connection and tab removal.
 * Must be called synchronously at module level in background.ts.
 */
export const initLedgerBLEBridgeListeners = bridge.initListeners

/** Get current bridge state. */
export const getLedgerBLEBridgeState = bridge.getState

/** Register a listener for Ledger BLE disconnect events. */
export const onLedgerBLEBridgeDisconnect = bridge.onDisconnect

/**
 * Open BLE transport on the bridge tab (triggers Web Bluetooth picker).
 */
export const openLedgerBLETransport = async (deviceId?: string): Promise<{deviceId: string; deviceName: string}> => {
  await bridge.openBridge()

  bridge.postMessage({
    type: 'LEDGER_BLE_OPEN',
    ...(deviceId != null && {deviceId}),
  } satisfies LedgerBLEBridgeRequest)
  const response = await bridge.waitForResponse('LEDGER_BLE_OPENED', LEDGER_BLE_OPEN_TIMEOUT)
  bridge.setState('connected')
  return {deviceId: response.deviceId as string, deviceName: response.deviceName as string}
}

/**
 * Send an APDU command through the bridge.
 */
export const sendLedgerBLEAPDU = async (
  cla: number,
  ins: number,
  p1: number,
  p2: number,
  dataHex?: string,
  timeout?: number,
): Promise<string> => {
  bridge.postMessage({
    type: 'LEDGER_BLE_SEND',
    cla,
    ins,
    p1,
    p2,
    ...(dataHex != null && {dataHex}),
  } satisfies LedgerBLEBridgeRequest)
  const response = await bridge.waitForResponse('LEDGER_BLE_SEND_RESULT', timeout ?? LEDGER_BLE_EXCHANGE_TIMEOUT)
  return response.dataHex as string
}

/**
 * Close the BLE transport (but keep the bridge tab for potential reconnection).
 */
export const closeLedgerBLETransport = () => bridge.closeTransport('LEDGER_BLE_CLOSE', 'LEDGER_BLE_CLOSED')

/**
 * Close the bridge entirely (transport + tab).
 */
export const closeLedgerBLEBridge = async (): Promise<void> => {
  await closeLedgerBLETransport()
  await bridge.closeBridge()
}
