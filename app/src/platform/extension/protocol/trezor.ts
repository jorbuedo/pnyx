/**
 * Shared typed message protocol between background service worker and Trezor BLE bridge tab.
 *
 * The Trezor BLE bridge tab runs in a regular browser tab where `navigator.bluetooth`
 * is available. It communicates with the background script via `chrome.runtime.connect()`
 * port messaging, relaying raw read/write operations (not APDU like Ledger).
 *
 * @module
 */

// ============================================================================
// Constants
// ============================================================================

export const TREZOR_BLE_BRIDGE_PORT_NAME = 'trezor-ble-bridge'

export const TREZOR_BLE_READ_TIMEOUT = 120_000
export const TREZOR_BLE_OPEN_TIMEOUT = 60_000
export const TREZOR_BLE_PING_INTERVAL = 15_000
export const TREZOR_BLE_PING_TIMEOUT = 5_000

// ============================================================================
// Bridge Tab → Background (Responses / Events)
// ============================================================================

export type TrezorBLEBridgeResponse =
  | {type: 'TREZOR_BLE_READY'}
  | {type: 'TREZOR_BLE_CONNECTED'; deviceId: string; deviceName: string}
  | {type: 'TREZOR_BLE_ENUMERATE_RESULT'; descriptors: Array<{path: string; type: number; id: string; apiType: string}>}
  | {type: 'TREZOR_BLE_READ_RESULT'; requestId: string; dataHex: string}
  | {type: 'TREZOR_BLE_READ_ERROR'; requestId: string; message: string}
  | {type: 'TREZOR_BLE_WRITE_RESULT'; requestId: string}
  | {type: 'TREZOR_BLE_WRITE_ERROR'; requestId: string; message: string}
  | {type: 'TREZOR_BLE_DEVICE_CHANGE'; descriptors: Array<{path: string; type: number; id: string; apiType: string}>}
  | {type: 'TREZOR_BLE_OPEN_DEVICE_RESULT'}
  | {type: 'TREZOR_BLE_CLOSED'}
  | {type: 'TREZOR_BLE_DISCONNECTED'; reason?: string}
  | {type: 'TREZOR_BLE_PONG'}
  | {type: 'TREZOR_BLE_ERROR'; message: string}

// ============================================================================
// Background → Bridge Tab (Requests)
// ============================================================================

export type TrezorBLEBridgeRequest =
  | {type: 'TREZOR_BLE_CONNECT'; deviceId?: string}
  | {type: 'TREZOR_BLE_ENUMERATE'}
  | {type: 'TREZOR_BLE_READ'; requestId: string; path: string}
  | {type: 'TREZOR_BLE_CANCEL_READ'; path: string}
  | {type: 'TREZOR_BLE_WRITE'; requestId: string; path: string; dataHex: string}
  | {type: 'TREZOR_BLE_OPEN_DEVICE'; path: string; channel?: string}
  | {type: 'TREZOR_BLE_CLOSE_DEVICE'; path: string; channel?: string}
  | {type: 'TREZOR_BLE_CLOSE'}
  | {type: 'TREZOR_BLE_PING'}

// ============================================================================
// Extension Message Types (Popup/App ↔ Background)
// ============================================================================

export type TrezorBLEBridgeExtensionMessage =
  | {type: 'TREZOR_BLE_BRIDGE_CONNECT'; deviceId?: string}
  | {type: 'TREZOR_BLE_BRIDGE_ENUMERATE'}
  | {type: 'TREZOR_BLE_BRIDGE_READ'; requestId: string; path: string}
  | {type: 'TREZOR_BLE_BRIDGE_CANCEL_READ'; path: string}
  | {type: 'TREZOR_BLE_BRIDGE_WRITE'; requestId: string; path: string; dataHex: string}
  | {type: 'TREZOR_BLE_BRIDGE_OPEN_DEVICE'; path: string; channel?: string}
  | {type: 'TREZOR_BLE_BRIDGE_CLOSE_DEVICE'; path: string; channel?: string}
  | {type: 'TREZOR_BLE_BRIDGE_CLOSE'}

export type TrezorBLEBridgeExtensionResponse =
  | {type: 'TREZOR_BLE_BRIDGE_CONNECTED'; deviceId: string; deviceName: string}
  | {
      type: 'TREZOR_BLE_BRIDGE_ENUMERATE_RESULT'
      descriptors: Array<{path: string; type: number; id: string; apiType: string}>
    }
  | {type: 'TREZOR_BLE_BRIDGE_READ_RESULT'; dataHex: string}
  | {type: 'TREZOR_BLE_BRIDGE_WRITE_RESULT'}
  | {type: 'TREZOR_BLE_BRIDGE_OPEN_DEVICE_RESULT'}
  | {type: 'TREZOR_BLE_BRIDGE_CLOSE_DEVICE_RESULT'}
  | {type: 'TREZOR_BLE_BRIDGE_CLOSED'}
  | {type: 'TREZOR_BLE_BRIDGE_ERROR'; message: string}

export type TrezorBLEDisconnectedBroadcast = {
  type: 'TREZOR_BLE_DISCONNECTED'
  reason?: string
}
