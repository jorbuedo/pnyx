/**
 * Platform-specific hardware wallet utilities - shared types.
 *
 * Platform-specific implementations are in:
 * - hardware.web.ts (browser/extension)
 * - hardware.native.ts (React Native mobile)
 *
 * Metro automatically picks the correct file based on the platform.
 *
 * @module
 */

// Re-export types and utilities from shared module
export type {
  BLEDevice,
  BLEScanSubscription,
  HardwarePlatformCapabilities,
  TransportTypeId,
  USBDevice,
} from './hardware.shared'

import {Effect} from 'effect'

import {
  getAvailableTransportTypes as getAvailableTransportTypesFromCaps,
  getBestTransportType as getBestTransportTypeFromCaps,
} from './hardware.shared'

// ============================================================================
// Platform detection stubs (overridden in platform files)
// ============================================================================

export const isUSBHIDSupported = (): boolean => false
export const isExtensionPlatform = (): boolean => false
export const isWebHIDAvailable = (): boolean => false
export const isBLEAvailable = (): boolean => false

// ============================================================================
// Shared utilities
// ============================================================================

/**
 * Get the hardware platform capabilities.
 * This is overridden in platform-specific files.
 */
export const getHardwareCapabilities = () => ({
  webHID: false,
  ble: false,
  usbHID: false,
  trezorPopup: false,
})

/**
 * Get the best available transport type for the current platform.
 */
export const getBestTransportType = () => getBestTransportTypeFromCaps(getHardwareCapabilities())

/**
 * Get all available transport types for the current platform.
 */
export const getAvailableTransportTypes = () => getAvailableTransportTypesFromCaps(getHardwareCapabilities())

// ============================================================================
// Operation stubs (overridden in platform files)
// ============================================================================

export const TREZOR_USB_FILTERS: ReadonlyArray<{vendorId: number; productId?: number}> = []

export const requestWebHIDPermission = async (): Promise<unknown[]> => []
export const getPermittedWebHIDDevices = async (): Promise<unknown[]> => []
export const requestWebUSBPermissionForTrezor = async (): Promise<unknown> => {
  throw new Error('WebUSB is only available on web')
}
export const getPermittedWebUSBTrezorDevices = async (): Promise<
  ReadonlyArray<{vendorId: number; productId: number; productName: string}>
> => []
export const requestBLEPermissions = async (): Promise<boolean> => false
export const startBLEScan = (
  _onDevice: (device: {id: string; name: string; rssi?: number; vendor: 'ledger' | 'trezor'}) => void,
) => ({
  unsubscribe: () => {},
})
export const stopBLE = async (): Promise<void> => {}
export const listUSBDevices = async (): Promise<
  {id: string; vendorId: number; productId: number; productName: string}[]
> => []

export const startUSBScan = (
  _onDevice: (device: {id: string; descriptor: unknown}) => void,
  _options?: {onError?: (error: Error) => void; onComplete?: () => void},
) => ({
  unsubscribe: () => {},
})

export const isHardwareUSBSupported = (): boolean => false

export const startHardwareUSBScan = (_handlers: {
  onDevice: (device: {id: string; name: string; vendor: 'ledger' | 'trezor'}) => void
  onDeviceLost?: (id: string) => void
}) => ({
  unsubscribe: () => {},
})

export const createUSBTransportFactoryForDevice = async (
  _descriptor: unknown,
): Promise<import('@pnyx/hardware').LedgerTransportFactory> => {
  throw new Error('USB HID transport is only available on Android')
}

// Stub for non-native platforms - will be overridden
export const createBLETransportFactoryForDevice = async (
  _deviceId?: string,
): Promise<import('@pnyx/hardware').LedgerTransportFactory> => {
  throw new Error('BLE transport is only available on native platforms')
}

export const createLedgerTransportFactory = (_opts?: {
  readonly prefer?: 'usb' | 'ble'
}): Effect.Effect<import('@pnyx/hardware').LedgerTransportFactory, Error> =>
  Effect.fail(new Error('No compatible transport available'))

// No-op stubs — overridden in platform files
export const onWebDeviceConnect =
  (_callback: (info: {vendorId: number; productId: number; productName: string}) => void): (() => void) =>
  () => {}
export const onWebDeviceDisconnect =
  (_callback: (info: {vendorId: number; productId: number; opened: boolean}) => void): (() => void) =>
  () => {}
