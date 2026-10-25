/**
 * Ledger BLE bridge transport factory for the browser extension.
 *
 * DORMANT (see `../runtime` and `docs/EXTENSION.md`). Creates a
 * `LedgerTransportFactory` / `LedgerTransport` that relay APDU commands through
 * extension messaging to the Ledger BLE bridge tab. This is the app-bundle
 * (Metro) client half, NOT the extension background bundle.
 *
 * @module
 */

import type {LedgerTransport, LedgerTransportFactory} from '@pnyx/hardware'
import type {LedgerBLEBridgeExtensionMessage, LedgerBLEBridgeExtensionResponse} from '../protocol/ledger'
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

/** Send a Ledger BLE bridge message and wait for the response. */
const sendLedgerBLEMessage = async <T extends LedgerBLEBridgeExtensionResponse>(
  message: LedgerBLEBridgeExtensionMessage,
): Promise<T> => {
  const response = await sendMessage<
    {type: 'SUCCESS'; payload: LedgerBLEBridgeExtensionResponse} | {type: 'ERROR'; payload: {message: string}}
  >(message)
  if (!response || !('type' in response)) {
    throw new Error('Ledger BLE bridge: no response received')
  }
  if (response.type === 'ERROR') {
    throw new Error(response.payload.message)
  }
  const inner = response.payload
  if (inner.type === 'LEDGER_BLE_BRIDGE_ERROR') {
    throw new Error(inner.message)
  }
  return inner as T
}

/**
 * Create a `LedgerTransport` that relays through extension messaging.
 */
const createLedgerBLEBridgeTransport = (): LedgerTransport => {
  let exchangeTimeout: number | undefined

  return {
    send: async (cla: number, ins: number, p1: number, p2: number, data?: Uint8Array): Promise<Uint8Array> => {
      const response = await sendLedgerBLEMessage<
        Extract<LedgerBLEBridgeExtensionResponse, {type: 'LEDGER_BLE_BRIDGE_SEND_RESULT'}>
      >({
        type: 'LEDGER_BLE_BRIDGE_SEND',
        cla,
        ins,
        p1,
        p2,
        ...(data != null && {dataHex: bytesToHex(data)}),
        ...(exchangeTimeout != null && {timeout: exchangeTimeout}),
      })
      return hexToBytes(response.dataHex)
    },

    close: async (): Promise<void> => {
      await sendLedgerBLEMessage({type: 'LEDGER_BLE_BRIDGE_CLOSE'})
    },

    setExchangeTimeout: (timeout: number): void => {
      exchangeTimeout = timeout
    },
  }
}

/**
 * Create a `LedgerTransportFactory` that uses the Ledger BLE bridge for device communication.
 *
 * @param deviceId - Optional device ID for reconnection (skips Bluetooth picker)
 */
export const createLedgerBLEBridgeTransportFactory = (deviceId?: string): LedgerTransportFactory => ({
  create: async (): Promise<LedgerTransport> => {
    await sendLedgerBLEMessage<Extract<LedgerBLEBridgeExtensionResponse, {type: 'LEDGER_BLE_BRIDGE_CONNECTED'}>>({
      type: 'LEDGER_BLE_BRIDGE_CONNECT',
      ...(deviceId != null && {deviceId}),
    })
    return createLedgerBLEBridgeTransport()
  },

  open: async (descriptor: unknown): Promise<LedgerTransport> => {
    const id = typeof descriptor === 'string' ? descriptor : deviceId
    await sendLedgerBLEMessage<Extract<LedgerBLEBridgeExtensionResponse, {type: 'LEDGER_BLE_BRIDGE_CONNECTED'}>>({
      type: 'LEDGER_BLE_BRIDGE_CONNECT',
      ...(id != null && {deviceId: id}),
    })
    return createLedgerBLEBridgeTransport()
  },
})
