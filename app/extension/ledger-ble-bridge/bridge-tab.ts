/// <reference types="chrome" />
/**
 * Script running inside the Ledger BLE bridge tab.
 *
 * Connects to the background service worker via `chrome.runtime.connect()`,
 * manages the Web Bluetooth transport, and relays APDU commands.
 *
 * Web Bluetooth's `requestDevice()` requires a user gesture, so for first-time
 * pairing (no deviceId) when a `LEDGER_BLE_OPEN` arrives we show a "Select Ledger
 * Device" button and defer the actual pairing until the user clicks it.
 *
 * For reconnection to a known device (deviceId provided), we auto-connect
 * without requiring a user gesture — `TransportWebBLE.open(id)` uses
 * `getDevices()` + `gatt.connect()` which works for previously paired devices.
 *
 * Bundled by esbuild (not Metro) as a standalone entry point.
 *
 * @module
 */

import TransportWebBLE from '@ledgerhq/hw-transport-web-ble'
import {
  LEDGER_BLE_BRIDGE_PORT_NAME,
  type LedgerBLEBridgeRequest,
  type LedgerBLEBridgeResponse,
} from '../../src/platform/extension/protocol/ledger'

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

// Suppress unhandled GATT errors from @ledgerhq/hw-transport-web-ble internals.
// The library calls characteristic.stopNotifications() during cleanup without catching
// the rejection when the GATT server is already disconnected.
self.addEventListener('unhandledrejection', (event) => {
  if (
    event.reason instanceof DOMException &&
    event.reason.message.includes('GATT') &&
    (event.reason.message.includes('disconnect') || event.reason.message.includes('stopNotifications'))
  ) {
    event.preventDefault()
  }
})

let transport: InstanceType<typeof TransportWebBLE> | null = null
let pendingDeviceId: string | undefined

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

const port = chrome.runtime.connect({name: LEDGER_BLE_BRIDGE_PORT_NAME})

const send = (msg: LedgerBLEBridgeResponse) => {
  port.postMessage(msg)
}

// BLE open (called from button click — has user gesture)
const performOpen = async (deviceId?: string) => {
  try {
    // Close existing transport before opening a new one (e.g. after app switch
    // where the Ledger restarted and we need a fresh GATT connection).
    if (transport) {
      try {
        await transport.close()
      } catch {
        // Best effort — transport may already be disconnected
      }
      transport = null
    }

    hideConnectButton()

    if (deviceId) {
      // Reconnection with known device — poll aggressively because the Ledger
      // needs time to restart its BLE stack after an app switch (~2-5s).
      const maxAttempts = 15
      const pollInterval = 500
      const startTime = Date.now()
      let lastError: Error | undefined
      for (let i = 0; i < maxAttempts; i++) {
        if (i > 0) {
          // Safety: bail if total elapsed time exceeds 25s (prevents runaway retries
          // if individual attempts take longer than expected).
          if (Date.now() - startTime > 25_000) break
          setStatus(`Reconnecting to Ledger... (${i}/${maxAttempts})`)
          await new Promise((resolve) => setTimeout(resolve, pollInterval))
        } else {
          setStatus('Reconnecting to Ledger...')
        }
        try {
          // Per-attempt timeout: TransportWebBLE.open() can block for 30-60s on some
          // devices/platforms during GATT negotiation. Limit each attempt to 8s so the
          // retry loop can progress and the 25s wall-clock guard remains effective.
          const attemptTimeout = 8_000
          transport = (await Promise.race([
            TransportWebBLE.open(deviceId),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('BLE open attempt timed out')), attemptTimeout),
            ),
          ])) as InstanceType<typeof TransportWebBLE>
          lastError = undefined
          break
        } catch (e) {
          lastError = e instanceof Error ? e : new Error(String(e))
        }
      }
      if (lastError) throw lastError
    } else {
      setStatus('Scanning for Ledger devices...')
      transport = (await TransportWebBLE.create()) as InstanceType<typeof TransportWebBLE>
    }

    // Extract device info from the transport
    const bleDevice = (transport as unknown as {device?: {name?: string; id?: string}}).device
    const name = bleDevice?.name ?? 'Ledger'
    // The id is what the client reconnects with — a placeholder would fail later
    // and look like a device fault, so surface the absence here instead.
    const id = bleDevice?.id ?? deviceId
    if (id === undefined || id === '') throw new Error('Connected Ledger reported no BLE device id')

    // Listen for disconnect
    transport?.on('disconnect', () => {
      transport = null
      setStatus('Disconnected')
      setDeviceName('')
      send({type: 'LEDGER_BLE_DISCONNECTED', reason: 'device disconnected'})
    })

    setStatus('Connected')
    setDeviceName(name)
    send({type: 'LEDGER_BLE_OPENED', deviceId: id, deviceName: name})
  } catch (error) {
    // Save deviceId so the retry button can use it
    pendingDeviceId = deviceId
    setStatus('Connection failed — click to retry')
    showConnectButton()
    const message = error instanceof Error ? error.message : String(error)
    send({type: 'LEDGER_BLE_ERROR', message: `BLE open failed: ${message}`})
  }
}

// Button click handler (provides the user gesture for requestDevice)
if (connectBtn) {
  connectBtn.addEventListener('click', () => {
    performOpen(pendingDeviceId)
  })
}

const handleOpen = async (deviceId?: string) => {
  if (deviceId) {
    // Known device — try auto-connecting without requiring a user gesture.
    // TransportWebBLE.open(id) uses getDevices() + gatt.connect() which
    // works for previously paired devices without a user gesture.
    setStatus('Reconnecting to Ledger...')
    hideConnectButton()
    await performOpen(deviceId)
    return
  }

  // No deviceId — require user gesture for Bluetooth picker
  pendingDeviceId = deviceId
  setStatus('Click the button below to pair your Ledger')
  showConnectButton()
}

const handleSend = async (cla: number, ins: number, p1: number, p2: number, dataHex?: string) => {
  if (!transport) {
    send({type: 'LEDGER_BLE_SEND_ERROR', message: 'No BLE transport available'})
    return
  }

  try {
    const data = dataHex ? hexToBytes(dataHex) : undefined
    const result = await transport.send(cla, ins, p1, p2, data as Buffer | undefined)
    send({type: 'LEDGER_BLE_SEND_RESULT', dataHex: bytesToHex(new Uint8Array(result))})
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    send({type: 'LEDGER_BLE_SEND_ERROR', message})
  }
}

const handleClose = async () => {
  if (transport) {
    try {
      await transport.close()
    } catch {
      // Best effort
    }
    transport = null
  }
  setStatus('Disconnected')
  setDeviceName('')
  hideConnectButton()
  send({type: 'LEDGER_BLE_CLOSED'})
}

port.onMessage.addListener((msg: LedgerBLEBridgeRequest) => {
  switch (msg.type) {
    case 'LEDGER_BLE_OPEN':
      handleOpen(msg.deviceId).catch((e) => {
        send({type: 'LEDGER_BLE_ERROR', message: e instanceof Error ? e.message : String(e)})
      })
      break
    case 'LEDGER_BLE_SEND':
      handleSend(msg.cla, msg.ins, msg.p1, msg.p2, msg.dataHex)
      break
    case 'LEDGER_BLE_CLOSE':
      handleClose()
      break
    case 'LEDGER_BLE_PING':
      send({type: 'LEDGER_BLE_PONG'})
      break
  }
})

// When the background disconnects (service worker restart, etc.), clean up
port.onDisconnect.addListener(async () => {
  if (transport) {
    try {
      await transport.close()
    } catch {
      // Best effort
    }
    transport = null
  }
  setStatus('Background disconnected — please close this tab')
  hideConnectButton()
})

// Signal readiness
setStatus('Ready — waiting for connection request...')
send({type: 'LEDGER_BLE_READY'})
