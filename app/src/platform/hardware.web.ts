/**
 * Web platform hardware wallet utilities.
 *
 * Uses WebHID for Ledger USB connections in browser/extension.
 *
 * @module
 */

import type {LedgerTransportFactory} from '@pnyx/hardware'
import {
  createWebHIDTransportFactory,
  createWebUSBTransportFactory,
  detectBestWebTransportFactory,
  hasWebHID,
  hasWebUSB,
} from '@pnyx/hardware/ledger-web'
import {Effect} from 'effect'
import {logger} from '../logger'
import {createLedgerBLEBridgeTransportFactory} from './extension/hw-bridge/ledger'
import {isExtension, sendMessage} from './extension/runtime'

// Re-export types from shared module (not ./hardware to avoid circular import)
export type {
  BLEDevice,
  BLEScanSubscription,
  HardwarePlatformCapabilities,
  ScanSubscription,
  TransportTypeId,
  USBDevice,
} from './hardware.shared'

import {
  getAvailableTransportTypes as getAvailableTransportTypesFromCaps,
  getBestTransportType as getBestTransportTypeFromCaps,
} from './hardware.shared'

// ============================================================================
// WebHID Type Declarations
// ============================================================================

type HIDDevice = {
  readonly opened: boolean
  readonly vendorId: number
  readonly productId: number
  readonly productName: string
  open(): Promise<void>
  close(): Promise<void>
  forget(): Promise<void>
}

type HID = {
  getDevices(): Promise<HIDDevice[]>
  requestDevice(options: {filters: Array<{vendorId?: number; productId?: number}>}): Promise<HIDDevice[]>
  addEventListener(type: string, listener: (event: Event) => void): void
  removeEventListener(type: string, listener: (event: Event) => void): void
}

declare global {
  interface Navigator {
    readonly hid?: HID
  }
}

// ============================================================================
// Platform Detection (Web)
// ============================================================================

export const isUSBHIDSupported = (): boolean => false
export const isExtensionPlatform = (): boolean => isExtension
export const isWebHIDAvailable = (): boolean => hasWebHID()

/**
 * Whether Web Bluetooth is available in the current context.
 * True in extension fullscreen tabs; false in popups, sidepanels, and service workers.
 */
const hasWebBluetooth = (): boolean => typeof navigator !== 'undefined' && 'bluetooth' in navigator

/**
 * BLE is disabled on web/extension — only supported on mobile devices.
 */
export const isBLEAvailable = (): boolean => false

/**
 * Get the hardware platform capabilities for web.
 * BLE is disabled on web/extension — only supported on mobile devices.
 */
export const getHardwareCapabilities = () => ({
  webHID: hasWebHID(),
  ble: false,
  usbHID: false,
  trezorPopup: true,
})

/**
 * Get the best available transport type for web platform.
 */
export const getBestTransportType = () => getBestTransportTypeFromCaps(getHardwareCapabilities())

/**
 * Get all available transport types for web platform.
 */
export const getAvailableTransportTypes = () => getAvailableTransportTypesFromCaps(getHardwareCapabilities())

// ============================================================================
// WebHID Transport Factory
// ============================================================================

const LEDGER_VENDOR_ID = 0x2c97

/**
 * Trezor WebUSB filters — legacy T1 + the two newer T-series vendor/product
 * pairs. Single source of truth: `trezor/pairing.tsx`'s in-tab gesture picker,
 * the side-panel permission-tab popup (`device-permission.tsx`), and the
 * `/hardware` screen's inline listing all import from here.
 */
export const TREZOR_USB_FILTERS: ReadonlyArray<{vendorId: number; productId?: number}> = [
  {vendorId: 0x534c, productId: 0x0001},
  {vendorId: 0x1209, productId: 0x53c0},
  {vendorId: 0x1209, productId: 0x53c1},
]

const matchesTrezor = (d: {vendorId: number; productId: number}): boolean =>
  TREZOR_USB_FILTERS.some(
    (f) => f.vendorId === d.vendorId && (f.productId === undefined || f.productId === d.productId),
  )

/**
 * Request permission to access a Ledger device via WebHID. Must be invoked
 * under a real user gesture on Chromium.
 */
export const requestWebHIDPermission = async (): Promise<HIDDevice[]> => {
  if (!navigator.hid) {
    throw new Error('WebHID is not available')
  }
  return navigator.hid.requestDevice({
    filters: [{vendorId: LEDGER_VENDOR_ID}],
  })
}

/**
 * Get already-permitted WebHID devices (Ledger only — filtered by vendor ID).
 */
export const getPermittedWebHIDDevices = async (): Promise<HIDDevice[]> => {
  if (!navigator.hid) return []
  const devices = await navigator.hid.getDevices()
  return devices.filter((d) => d.vendorId === LEDGER_VENDOR_ID)
}

/**
 * Request permission to access a Trezor device via WebUSB. Must be invoked
 * under a real user gesture on Chromium.
 */
export const requestWebUSBPermissionForTrezor = async (): Promise<unknown> => {
  const usb = (typeof navigator !== 'undefined' ? (navigator as Navigator & {usb?: unknown}).usb : undefined) as
    | {requestDevice: (opts: {filters: ReadonlyArray<{vendorId: number; productId?: number}>}) => Promise<unknown>}
    | undefined
  if (!usb) throw new Error('WebUSB is not available')
  return usb.requestDevice({filters: TREZOR_USB_FILTERS})
}

/**
 * Get already-permitted WebUSB devices that match Trezor vendor/product IDs.
 */
export const getPermittedWebUSBTrezorDevices = async (): Promise<
  ReadonlyArray<{vendorId: number; productId: number; productName: string}>
> => {
  const usb = (typeof navigator !== 'undefined' ? (navigator as Navigator & {usb?: unknown}).usb : undefined) as
    | {getDevices: () => Promise<ReadonlyArray<{vendorId: number; productId: number; productName?: string}>>}
    | undefined
  if (!usb) return []
  const devices = await usb.getDevices()
  return devices
    .filter((d) => matchesTrezor(d))
    .map((d) => ({vendorId: d.vendorId, productId: d.productId, productName: d.productName ?? 'Trezor Device'}))
}

/**
 * Create a Ledger transport factory for web platforms.
 *
 * `prefer` is accepted for signature parity with the native variant; web
 * platforms always pick the same fallback chain (WebHID → WebUSB) because
 * there is no BLE option in browsers.
 */
export const createLedgerTransportFactory = (_opts?: {
  readonly prefer?: 'usb' | 'ble'
}): Effect.Effect<LedgerTransportFactory, Error> =>
  Effect.gen(function* () {
    if (hasWebHID()) {
      return yield* createWebHIDTransportFactory()
    }
    if (hasWebUSB()) {
      return yield* createWebUSBTransportFactory()
    }
    return yield* Effect.fail(new Error('No compatible web transport available'))
  })

/**
 * Detect and create the best available transport factory.
 */
export const detectBestTransportFactory = detectBestWebTransportFactory

// ============================================================================
// USB/HID Connect / Disconnect Detection
// ============================================================================

/**
 * Register a listener for hardware device USB/HID connections. Fires when
 * an already-permitted Ledger (WebHID) or Trezor (WebUSB) device is plugged
 * in. The /hardware screen uses this to keep the inline device list live
 * without re-polling.
 *
 * @returns Cleanup function to remove the listeners.
 */
export const onWebDeviceConnect = (
  callback: (info: {vendorId: number; productId: number; productName: string}) => void,
): (() => void) => {
  const cleanups: Array<() => void> = []

  if (typeof navigator !== 'undefined' && navigator.hid) {
    const handler = (event: Event) => {
      const device = (event as Event & {device: HIDDevice}).device
      callback({vendorId: device.vendorId, productId: device.productId, productName: device.productName})
    }
    navigator.hid.addEventListener('connect', handler)
    cleanups.push(() => navigator.hid?.removeEventListener('connect', handler))
  }

  if (typeof navigator !== 'undefined' && 'usb' in navigator) {
    const usb = navigator.usb as EventTarget
    const handler = (event: Event) => {
      const device = (event as Event & {device: {vendorId: number; productId: number; productName?: string}}).device
      callback({vendorId: device.vendorId, productId: device.productId, productName: device.productName ?? ''})
    }
    usb.addEventListener('connect', handler)
    cleanups.push(() => usb.removeEventListener('connect', handler))
  }

  return () => {
    for (const c of cleanups) c()
  }
}

/**
 * Register a listener for hardware device USB/HID disconnections.
 * Listens to both WebHID and WebUSB disconnect events.
 *
 * @returns Cleanup function to remove the listeners.
 */
export const onWebDeviceDisconnect = (
  callback: (info: {vendorId: number; productId: number; opened: boolean}) => void,
): (() => void) => {
  const cleanups: Array<() => void> = []

  // WebHID disconnect listener (primary transport)
  if (typeof navigator !== 'undefined' && navigator.hid) {
    const handler = (event: Event) => {
      const device = (event as Event & {device: HIDDevice}).device
      callback({vendorId: device.vendorId, productId: device.productId, opened: device.opened})
    }
    navigator.hid.addEventListener('disconnect', handler)
    cleanups.push(() => navigator.hid?.removeEventListener('disconnect', handler))
  }

  // WebUSB disconnect listener (fallback transport)
  if (typeof navigator !== 'undefined' && 'usb' in navigator) {
    const usb = navigator.usb as EventTarget
    const handler = (event: Event) => {
      const device = (event as Event & {device: {vendorId: number; productId: number; opened: boolean}}).device
      callback({vendorId: device.vendorId, productId: device.productId, opened: device.opened})
    }
    usb.addEventListener('disconnect', handler)
    cleanups.push(() => usb.removeEventListener('disconnect', handler))
  }

  return () => {
    for (const cleanup of cleanups) cleanup()
  }
}

// ============================================================================
// BLE via Extension Bridge
// ============================================================================

export const requestBLEPermissions = async (): Promise<boolean> => {
  // Web Bluetooth permissions are handled by the browser picker in the bridge tab
  return isExtensionPlatform()
}

export const startBLEScan = (_onDevice: (device: {id: string; name: string; vendor: 'ledger' | 'trezor'}) => void) => ({
  // BLE scanning is handled by the Web Bluetooth picker in the bridge tab
  unsubscribe: () => {},
})

// No USB host mode on web — Trezor over USB goes through the WebUSB picker.
export const isHardwareUSBSupported = (): boolean => false

export const startHardwareUSBScan = (_handlers: {
  onDevice: (device: {id: string; name: string; vendor: 'ledger' | 'trezor'}) => void
  onDeviceLost?: (id: string) => void
}) => ({
  unsubscribe: () => {},
})

export const stopBLE = async (): Promise<void> => {
  // In extension contexts, close the BLE bridge
  if (isExtensionPlatform()) {
    await sendMessage({type: 'LEDGER_BLE_BRIDGE_CLOSE'}).catch((e) => {
      logger.warn('Failed to close the Ledger BLE bridge', {origin: 'hardware.web', error: String(e)})
    })
    return
  }
  // Direct Web Bluetooth: nothing to tear down globally (transport.close() handles it)
}

// ============================================================================
// USB HID Stubs (not available on web - use WebHID instead)
// ============================================================================

export const listUSBDevices = async () => []

export const startUSBScan = (
  _onDevice: (device: {id: string; descriptor: unknown}) => void,
  _options?: {onError?: (error: Error) => void; onComplete?: () => void},
) => ({
  unsubscribe: () => {},
})

export const createUSBTransportFactoryForDevice = async (
  _descriptor: unknown,
): Promise<import('@pnyx/hardware').LedgerTransportFactory> => {
  throw new Error('USB HID transport is only available on Android')
}

// ============================================================================
// BLE Transport (direct Web Bluetooth or extension bridge)
// ============================================================================

export const createBLETransportFactoryForDevice = async (
  deviceId?: string,
): Promise<import('@pnyx/hardware').LedgerTransportFactory> => {
  // In extension contexts, always use the BLE bridge relay. Direct Web Bluetooth
  // is unreliable because Chrome blocks device pickers in side panels and popups.
  if (isExtensionPlatform()) {
    return createLedgerBLEBridgeTransportFactory(deviceId)
  }

  // On regular web pages, use direct Web Bluetooth
  if (hasWebBluetooth()) {
    const {default: TransportWebBLE} = await import('@ledgerhq/hw-transport-web-ble')
    return {
      create: async () => TransportWebBLE.create(),
      open: async (descriptor: unknown) => TransportWebBLE.open((descriptor ?? deviceId) as string),
    }
  }

  throw new Error('BLE transport is not available in this context')
}
