/// <reference types="chrome" />
/**
 * Hardware-wallet message routing for the background service worker.
 *
 * Two responsibilities:
 *  1. Relay the app-bundle client's `LEDGER_BLE_BRIDGE_*` / `TREZOR_BLE_BRIDGE_*`
 *     messages to the BLE bridge managers (which own the bridge tab running
 *     `navigator.bluetooth`), wrapping results in the `{type:'SUCCESS',payload}`
 *     / `{type:'ERROR',payload:{message}}` envelope the client transport expects.
 *  2. Open the camera-permission tab — the getUserMedia picker is blocked in
 *     side panels and popups, so it must run in a regular browsing context. (The
 *     USB/WebHID permission path lands with the app-side USB flow.) See
 *     `docs/EXTENSION.md`.
 *
 * @module
 */

import type {LedgerBLEBridgeExtensionResponse} from '../src/platform/extension/protocol/ledger'
import type {TrezorBLEBridgeExtensionResponse} from '../src/platform/extension/protocol/trezor'
import {
  closeLedgerBLETransport,
  initLedgerBLEBridgeListeners,
  openLedgerBLETransport,
  sendLedgerBLEAPDU,
} from './ledger-ble-bridge/bridge-manager'
import {
  cancelReadTrezorBLE,
  closeDeviceTrezorBLE,
  closeTrezorBLETransport,
  connectTrezorBLE,
  enumerateTrezorBLE,
  initTrezorBLEBridgeListeners,
  openDeviceTrezorBLE,
  readTrezorBLE,
  writeTrezorBLE,
} from './trezor-ble-bridge/bridge-manager'

type SendResponse = (response: unknown) => void

/** Wrap a device response in the envelope the client transport unwraps. */
const ok = (payload: unknown): {type: 'SUCCESS'; payload: unknown} => ({type: 'SUCCESS', payload})
const err = (e: unknown): {type: 'ERROR'; payload: {message: string}} => ({
  type: 'ERROR',
  payload: {message: e instanceof Error ? e.message : String(e)},
})

/** Settle a promise into the SUCCESS/ERROR envelope. */
const relay = (p: Promise<unknown>, sendResponse: SendResponse): true => {
  p.then(
    (payload) => sendResponse(ok(payload)),
    (e) => sendResponse(err(e)),
  )
  return true
}

/** In-extension app-shell URL for a hash route (opened as a regular tab). */
const fullscreenRoute = (route: string): string => `${chrome.runtime.getURL('index.html?fullscreen=true')}#${route}`

/** Open a regular tab at an app route (for pickers Chrome blocks in side panels). */
const openPermissionTab = (route: string, sendResponse: SendResponse): true => {
  chrome.tabs.create({url: fullscreenRoute(route), active: true}, () => sendResponse(ok({})))
  return true
}

/**
 * Register the BLE bridge port/tab listeners. Call synchronously at module load
 * in background.ts (chrome requires listeners registered on the first turn).
 */
export const initHardwareBridges = (): void => {
  initLedgerBLEBridgeListeners()
  initTrezorBLEBridgeListeners()
}

/**
 * Route a hardware-wallet or device-permission message.
 *
 * @returns `true` if handled asynchronously (caller must keep the message
 *   channel open), or `undefined` if the message is not ours (caller falls
 *   through to other handlers).
 */
export const handleHardwareMessage = (message: unknown, sendResponse: SendResponse): true | undefined => {
  if (typeof message !== 'object' || message === null) return undefined
  const msg = message as {type?: unknown}
  if (typeof msg.type !== 'string') return undefined

  switch (msg.type) {
    // --- Permission tab (the camera picker is blocked in side panels) --------
    case 'OPEN_CAMERA_PERMISSION_TAB':
      return openPermissionTab('/camera-permission', sendResponse)

    // --- Ledger BLE ----------------------------------------------------------
    case 'LEDGER_BLE_BRIDGE_CONNECT':
      return relay(
        openLedgerBLETransport((msg as {deviceId?: string}).deviceId).then(
          ({deviceId, deviceName}) =>
            ({type: 'LEDGER_BLE_BRIDGE_CONNECTED', deviceId, deviceName}) satisfies LedgerBLEBridgeExtensionResponse,
        ),
        sendResponse,
      )
    case 'LEDGER_BLE_BRIDGE_SEND': {
      const m = msg as {cla: number; ins: number; p1: number; p2: number; dataHex?: string; timeout?: number}
      return relay(
        sendLedgerBLEAPDU(m.cla, m.ins, m.p1, m.p2, m.dataHex, m.timeout).then(
          (dataHex) => ({type: 'LEDGER_BLE_BRIDGE_SEND_RESULT', dataHex}) satisfies LedgerBLEBridgeExtensionResponse,
        ),
        sendResponse,
      )
    }
    case 'LEDGER_BLE_BRIDGE_CLOSE':
      return relay(
        closeLedgerBLETransport().then(
          () => ({type: 'LEDGER_BLE_BRIDGE_CLOSED'}) satisfies LedgerBLEBridgeExtensionResponse,
        ),
        sendResponse,
      )

    // --- Trezor BLE ----------------------------------------------------------
    case 'TREZOR_BLE_BRIDGE_CONNECT':
      return relay(
        connectTrezorBLE().then(
          ({deviceId, deviceName}) =>
            ({type: 'TREZOR_BLE_BRIDGE_CONNECTED', deviceId, deviceName}) satisfies TrezorBLEBridgeExtensionResponse,
        ),
        sendResponse,
      )
    case 'TREZOR_BLE_BRIDGE_ENUMERATE':
      return relay(
        enumerateTrezorBLE().then(
          (descriptors) =>
            ({type: 'TREZOR_BLE_BRIDGE_ENUMERATE_RESULT', descriptors}) satisfies TrezorBLEBridgeExtensionResponse,
        ),
        sendResponse,
      )
    case 'TREZOR_BLE_BRIDGE_READ': {
      const m = msg as {requestId: string; path: string}
      return relay(
        readTrezorBLE(m.requestId, m.path).then(
          (dataHex) => ({type: 'TREZOR_BLE_BRIDGE_READ_RESULT', dataHex}) satisfies TrezorBLEBridgeExtensionResponse,
        ),
        sendResponse,
      )
    }
    case 'TREZOR_BLE_BRIDGE_WRITE': {
      const m = msg as {requestId: string; path: string; dataHex: string}
      return relay(
        writeTrezorBLE(m.requestId, m.path, m.dataHex).then(
          () => ({type: 'TREZOR_BLE_BRIDGE_WRITE_RESULT'}) satisfies TrezorBLEBridgeExtensionResponse,
        ),
        sendResponse,
      )
    }
    case 'TREZOR_BLE_BRIDGE_CANCEL_READ':
      cancelReadTrezorBLE((msg as {path: string}).path)
      sendResponse(ok({}))
      return true
    case 'TREZOR_BLE_BRIDGE_OPEN_DEVICE': {
      const m = msg as {path: string; channel?: string}
      return relay(
        openDeviceTrezorBLE(m.path, m.channel).then(
          () => ({type: 'TREZOR_BLE_BRIDGE_OPEN_DEVICE_RESULT'}) satisfies TrezorBLEBridgeExtensionResponse,
        ),
        sendResponse,
      )
    }
    case 'TREZOR_BLE_BRIDGE_CLOSE_DEVICE': {
      const m = msg as {path: string; channel?: string}
      return relay(
        closeDeviceTrezorBLE(m.path, m.channel).then(
          () => ({type: 'TREZOR_BLE_BRIDGE_CLOSE_DEVICE_RESULT'}) satisfies TrezorBLEBridgeExtensionResponse,
        ),
        sendResponse,
      )
    }
    case 'TREZOR_BLE_BRIDGE_CLOSE':
      return relay(
        closeTrezorBLETransport().then(
          () => ({type: 'TREZOR_BLE_BRIDGE_CLOSED'}) satisfies TrezorBLEBridgeExtensionResponse,
        ),
        sendResponse,
      )

    default:
      return undefined
  }
}
