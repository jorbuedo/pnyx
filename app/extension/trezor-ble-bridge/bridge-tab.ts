/// <reference types="chrome" />
/**
 * Script running inside the Trezor BLE bridge tab.
 *
 * Connects to the background service worker via `chrome.runtime.connect()`,
 * manages the Web Bluetooth connection using `webBluetoothManager`, and relays
 * raw read/write operations.
 *
 * Web Bluetooth's `requestDevice()` requires a user gesture, so when a
 * `TREZOR_BLE_CONNECT` arrives we show a "Select Trezor Device" button and defer
 * the actual pairing until the user clicks it.
 *
 * Bundled by esbuild (not Metro) as a standalone entry point.
 *
 * @module
 */

import {webBluetoothManager} from '@pnyx/hardware/trezor-web-ble'
import {
  TREZOR_BLE_BRIDGE_PORT_NAME,
  type TrezorBLEBridgeRequest,
  type TrezorBLEBridgeResponse,
} from '../../src/platform/extension/protocol/trezor'

// Inline hex helpers — Buffer is not available in extension tab context
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

let connectedDeviceId: string | null = null

const statusEl = document.getElementById('status')
const deviceNameEl = document.getElementById('device-name')
const connectBtn = document.getElementById('connect-btn') as HTMLButtonElement | null

const setStatus = (text: string) => {
  if (statusEl) statusEl.textContent = text
}

const setDeviceName = (name: string) => {
  if (deviceNameEl) deviceNameEl.textContent = name
}

const showConnectButton = () => {
  if (connectBtn) connectBtn.style.display = 'inline-block'
}

const hideConnectButton = () => {
  if (connectBtn) connectBtn.style.display = 'none'
}

const port = chrome.runtime.connect({name: TREZOR_BLE_BRIDGE_PORT_NAME})

const send = (msg: TrezorBLEBridgeResponse) => {
  port.postMessage(msg)
}

// BLE connect (called from button click — has user gesture)
const performConnect = async () => {
  try {
    hideConnectButton()
    setStatus('Scanning for Trezor devices...')

    const device = await webBluetoothManager.connectDevice({
      timeoutMs: 60_000,
      log: (...args: unknown[]) => console.debug('[TrezorBLEBridge]', ...args),
    })
    const deviceId = (device as {id: string}).id
    const name = (device as {name?: string}).name ?? 'Trezor'

    connectedDeviceId = deviceId

    setStatus('Connected')
    setDeviceName(name)
    send({type: 'TREZOR_BLE_CONNECTED', deviceId, deviceName: name})
  } catch (error) {
    setStatus('Connection failed — click to retry')
    showConnectButton()
    const message = error instanceof Error ? error.message : String(error)
    send({type: 'TREZOR_BLE_ERROR', message: `BLE connect failed: ${message}`})
  }
}

// Listen for BLE disconnect
webBluetoothManager.onDeviceConnectionStatusChange((event) => {
  if (event.connectionStatus.type === 'disconnected') {
    connectedDeviceId = null
    setStatus('Disconnected')
    setDeviceName('')
    send({type: 'TREZOR_BLE_DISCONNECTED', reason: 'device disconnected'})
  }
})

// Button click handler (provides the user gesture for requestDevice)
if (connectBtn) {
  connectBtn.addEventListener('click', () => {
    performConnect()
  })
}

const DEVICE_TYPE_BLUETOOTH = 6

const getDescriptors = () => {
  const ids = webBluetoothManager.getConnectedDeviceIds()
  return ids.map((id) => ({
    path: id,
    type: DEVICE_TYPE_BLUETOOTH,
    id,
    apiType: 'bluetooth' as const,
  }))
}

const handleConnect = () => {
  setStatus('Click the button below to pair your Trezor')
  showConnectButton()
}

const handleEnumerate = () => {
  send({type: 'TREZOR_BLE_ENUMERATE_RESULT', descriptors: getDescriptors()})
}

const handleRead = async (requestId: string, path: string) => {
  try {
    const result = await webBluetoothManager.read(path)
    if (result.success) {
      send({type: 'TREZOR_BLE_READ_RESULT', requestId, dataHex: bytesToHex(result.payload as Uint8Array)})
    } else {
      send({type: 'TREZOR_BLE_READ_ERROR', requestId, message: (result as {error?: string}).error ?? 'read failed'})
    }
  } catch (err: unknown) {
    send({type: 'TREZOR_BLE_READ_ERROR', requestId, message: err instanceof Error ? err.message : String(err)})
  }
}

const handleCancelRead = (path: string) => {
  webBluetoothManager.cancelRead(path)
}

const handleWrite = async (requestId: string, path: string, dataHex: string) => {
  try {
    await webBluetoothManager.write(path, hexToBytes(dataHex))
    send({type: 'TREZOR_BLE_WRITE_RESULT', requestId})
  } catch (err: unknown) {
    send({type: 'TREZOR_BLE_WRITE_ERROR', requestId, message: err instanceof Error ? err.message : String(err)})
  }
}

const handleClose = () => {
  if (connectedDeviceId) {
    webBluetoothManager.disconnectDevice({deviceId: connectedDeviceId})
    connectedDeviceId = null
  }
  setStatus('Disconnected')
  setDeviceName('')
  hideConnectButton()
  send({type: 'TREZOR_BLE_CLOSED'})
}

port.onMessage.addListener((msg: TrezorBLEBridgeRequest) => {
  switch (msg.type) {
    case 'TREZOR_BLE_CONNECT':
      handleConnect()
      break
    case 'TREZOR_BLE_ENUMERATE':
      handleEnumerate()
      break
    case 'TREZOR_BLE_READ':
      handleRead(msg.requestId, msg.path)
      break
    case 'TREZOR_BLE_CANCEL_READ':
      handleCancelRead(msg.path)
      break
    case 'TREZOR_BLE_WRITE':
      handleWrite(msg.requestId, msg.path, msg.dataHex)
      break
    case 'TREZOR_BLE_OPEN_DEVICE':
      send({type: 'TREZOR_BLE_OPEN_DEVICE_RESULT'})
      break
    case 'TREZOR_BLE_CLOSE_DEVICE':
      if (msg.channel === 'read') webBluetoothManager.cancelRead(msg.path)
      send({type: 'TREZOR_BLE_CLOSED'})
      break
    case 'TREZOR_BLE_CLOSE':
      handleClose()
      break
    case 'TREZOR_BLE_PING':
      send({type: 'TREZOR_BLE_PONG'})
      break
  }
})

// When the background disconnects, clean up
port.onDisconnect.addListener(() => {
  if (connectedDeviceId) {
    webBluetoothManager.disconnectDevice({deviceId: connectedDeviceId})
  }
  setStatus('Background disconnected — please close this tab')
  hideConnectButton()
})

// Signal readiness
setStatus('Ready — waiting for connection request...')
send({type: 'TREZOR_BLE_READY'})
