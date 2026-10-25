/**
 * Shared typed message protocol between background service worker and Ledger BLE bridge tab.
 *
 * The Ledger BLE bridge tab runs in a regular browser tab where `navigator.bluetooth`
 * is available. It communicates with the background script via `chrome.runtime.connect()`
 * port messaging.
 *
 * @module
 */

// ============================================================================
// Constants
// ============================================================================

/** Port name used by the Ledger BLE bridge tab when connecting to the background. */
export const LEDGER_BLE_BRIDGE_PORT_NAME = 'ledger-ble-bridge'

/** APDU exchange timeout (ms). */
export const LEDGER_BLE_EXCHANGE_TIMEOUT = 120_000

/** Bridge open timeout (ms) — how long to wait for the bridge tab to connect. */
export const LEDGER_BLE_OPEN_TIMEOUT = 30_000

/** Ping interval (ms) — background pings bridge to detect unresponsive tabs. */
export const LEDGER_BLE_PING_INTERVAL = 15_000

/** Ping timeout (ms) — if no pong within this window, bridge is considered dead. */
export const LEDGER_BLE_PING_TIMEOUT = 5_000

// ============================================================================
// Bridge Tab → Background (Responses / Events)
// ============================================================================

export type LedgerBLEBridgeResponse =
  | {type: 'LEDGER_BLE_READY'}
  | {type: 'LEDGER_BLE_OPENED'; deviceId: string; deviceName: string}
  | {type: 'LEDGER_BLE_SEND_RESULT'; dataHex: string}
  | {type: 'LEDGER_BLE_SEND_ERROR'; message: string}
  | {type: 'LEDGER_BLE_CLOSED'}
  | {type: 'LEDGER_BLE_DISCONNECTED'; reason?: string}
  | {type: 'LEDGER_BLE_PONG'}
  | {type: 'LEDGER_BLE_ERROR'; message: string}

// ============================================================================
// Background → Bridge Tab (Requests)
// ============================================================================

export type LedgerBLEBridgeRequest =
  | {type: 'LEDGER_BLE_OPEN'; deviceId?: string}
  | {type: 'LEDGER_BLE_SEND'; cla: number; ins: number; p1: number; p2: number; dataHex?: string}
  | {type: 'LEDGER_BLE_CLOSE'}
  | {type: 'LEDGER_BLE_PING'}

// ============================================================================
// Extension Message Types (Popup/App ↔ Background)
// ============================================================================

export type LedgerBLEBridgeExtensionMessage =
  | {type: 'LEDGER_BLE_BRIDGE_CONNECT'; deviceId?: string}
  | {
      type: 'LEDGER_BLE_BRIDGE_SEND'
      cla: number
      ins: number
      p1: number
      p2: number
      dataHex?: string
      timeout?: number
    }
  | {type: 'LEDGER_BLE_BRIDGE_CLOSE'}

export type LedgerBLEBridgeExtensionResponse =
  | {type: 'LEDGER_BLE_BRIDGE_CONNECTED'; deviceId: string; deviceName: string}
  | {type: 'LEDGER_BLE_BRIDGE_SEND_RESULT'; dataHex: string}
  | {type: 'LEDGER_BLE_BRIDGE_CLOSED'}
  | {type: 'LEDGER_BLE_BRIDGE_ERROR'; message: string}

/** Broadcast event sent to all extension contexts when Ledger BLE disconnects. */
export type LedgerBLEDisconnectedBroadcast = {
  type: 'LEDGER_BLE_DISCONNECTED'
  reason?: string
}
