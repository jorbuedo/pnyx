/**
 * Shared types and utilities for hardware wallet platform implementations.
 *
 * This file is imported by both hardware.web.ts and hardware.native.ts
 * to avoid circular imports (Metro resolves ./hardware to the platform-specific file).
 *
 * @module
 */

// ============================================================================
// Types (shared across all platforms)
// ============================================================================

/**
 * Hardware wallet vendor that a discovered device belongs to.
 *
 * Inferred from the BLE service UUID(s) the device advertises during a
 * scan. Used by the connect UI to route discovered devices to the right
 * vendor-specific pairing flow.
 */
export type HardwareVendor = 'ledger' | 'trezor'

/**
 * BLE device discovered during scanning.
 */
export type BLEDevice = {
  readonly id: string
  readonly name: string
  readonly rssi?: number
  /**
   * Which vendor's BLE service UUID the device advertised. Set by the
   * native scanner from the matched service UUID, falling back to name
   * heuristics only when serviceUUIDs aren't surfaced by the platform.
   */
  readonly vendor: HardwareVendor
}

/**
 * USB HID device discovered.
 */
export type USBDevice = {
  readonly id: string
  readonly vendorId: number
  readonly productId: number
  readonly productName: string
  /** Native USB device descriptor for TransportHID.open() — opaque, must not be serialized */
  readonly descriptor: unknown
}

/**
 * Platform capabilities for hardware wallet support.
 */
export type HardwarePlatformCapabilities = {
  /** Whether WebHID is supported (browser extension) */
  readonly webHID: boolean
  /** Whether BLE is supported (mobile) */
  readonly ble: boolean
  /** Whether USB HID is supported (Android) */
  readonly usbHID: boolean
  /** Whether TrezorConnect popup can be used */
  readonly trezorPopup: boolean
}

/**
 * Scan subscription for cleanup (BLE or USB).
 */
export type ScanSubscription = {
  readonly unsubscribe: () => void
}

/** @deprecated Use ScanSubscription instead */
export type BLEScanSubscription = ScanSubscription

/**
 * Transport type identifiers.
 */
export type TransportTypeId = 'webhid' | 'ble' | 'usb-hid'

// ============================================================================
// Shared utilities
// ============================================================================

/**
 * Get the best available transport type based on capabilities.
 */
export const getBestTransportType = (capabilities: HardwarePlatformCapabilities): TransportTypeId | null => {
  if (capabilities.webHID) return 'webhid'
  if (capabilities.ble) return 'ble'
  if (capabilities.usbHID) return 'usb-hid'
  return null
}

/**
 * Get all available transport types based on capabilities.
 */
export const getAvailableTransportTypes = (capabilities: HardwarePlatformCapabilities): TransportTypeId[] => {
  const types: TransportTypeId[] = []
  if (capabilities.webHID) types.push('webhid')
  if (capabilities.ble) types.push('ble')
  if (capabilities.usbHID) types.push('usb-hid')
  return types
}
