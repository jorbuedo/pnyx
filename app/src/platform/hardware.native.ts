/**
 * Native platform hardware wallet utilities.
 *
 * Uses BLE for iOS/Android and USB HID for Android.
 *
 * @module
 */

import TransportHID from '@ledgerhq/react-native-hid'
import TransportBLE from '@ledgerhq/react-native-hw-transport-ble'
import type {LedgerTransportFactory} from '@pnyx/hardware'
import {
  createBLETransportFactory,
  createUSBHIDTransportFactory,
  openBLETransport,
  openUSBHIDTransport,
} from '@pnyx/hardware/ledger-native'
// Imported by subpath, not via the trezor-native barrel, so the pair screen
// doesn't drag the BLE manager in at app boot.
import {startTrezorUsbScan} from '@pnyx/hardware/trezor-native/usb/scan'
import {Effect} from 'effect'
import {PermissionsAndroid, Platform} from 'react-native'
import {logger} from '../logger'
import {getBleManager} from './bluetooth-state.native'
import {platformIsAndroid, platformIsIOS} from './detect'
import {encodeLedgerUsbId} from './ledger-usb-device'

// Re-export shared types (from .shared to avoid circular import)
export type {
  BLEDevice,
  BLEScanSubscription,
  HardwarePlatformCapabilities,
  ScanSubscription,
  TransportTypeId,
  USBDevice,
} from './hardware.shared'

import type {
  BLEDevice,
  BLEScanSubscription,
  HardwarePlatformCapabilities,
  HardwareVendor,
  ScanSubscription,
  TransportTypeId,
  USBDevice,
} from './hardware.shared'

// ============================================================================
// Platform Detection (Native)
// ============================================================================

const USB_HID_MIN_ANDROID_API = 24

export const isUSBHIDSupported = (): boolean => {
  if (!platformIsAndroid) return false
  return typeof Platform.Version === 'number' && Platform.Version >= USB_HID_MIN_ANDROID_API
}

export const isExtensionPlatform = (): boolean => false
export const isWebHIDAvailable = (): boolean => false
export const isBLEAvailable = (): boolean => platformIsIOS || platformIsAndroid

export const getHardwareCapabilities = (): HardwarePlatformCapabilities => ({
  webHID: false,
  ble: isBLEAvailable(),
  usbHID: isUSBHIDSupported(),
  trezorPopup: false,
})

export const getBestTransportType = (): TransportTypeId | null => {
  if (isBLEAvailable()) return 'ble'
  if (isUSBHIDSupported()) return 'usb-hid'
  return null
}

export const getAvailableTransportTypes = (): TransportTypeId[] => {
  const types: TransportTypeId[] = []
  if (isBLEAvailable()) types.push('ble')
  if (isUSBHIDSupported()) types.push('usb-hid')
  return types
}

// ============================================================================
// BLE Permissions and Scanning
// ============================================================================

/**
 * BLE service UUIDs the scanner filters on.
 *
 * Ledger advertises one UUID per device family (Nano X, Stax, Flex, Apex/Gen5).
 * Trezor advertises a single UUID (Safe 5 / Safe 7). All values are lowercased
 * to match `react-native-ble-plx`'s `device.serviceUUIDs` normalization on
 * Android — case-insensitive in spec but case-sensitive in equality checks.
 *
 * Refs:
 * - Ledger: `@ledgerhq/devices` `bluetoothSpec.serviceUuid` per model.
 * - Trezor: `packages/hardware/trezor-protocol/ble/constants.ts` (TrezorService.uuid).
 */
const LEDGER_BLE_SERVICE_UUIDS = [
  '13d63400-2c97-0004-0000-4c6564676572', // Nano X
  '13d63400-2c97-8004-0000-4c6564676572', // Apex / Gen5
  '13d63400-2c97-6004-0000-4c6564676572', // Stax
  '13d63400-2c97-3004-0000-4c6564676572', // Flex
] as const
const TREZOR_BLE_SERVICE_UUID = '8c000001-a59b-4d58-a9ad-073df69fa1b1'

const ALL_BLE_SERVICE_UUIDS: ReadonlyArray<string> = [...LEDGER_BLE_SERVICE_UUIDS, TREZOR_BLE_SERVICE_UUID]

/**
 * Decide which vendor a scanned device belongs to.
 *
 * Prefers service-UUID match (deterministic). Falls back to the device-name
 * prefix only when `serviceUUIDs` is empty — Android occasionally surfaces an
 * empty array on the first emission before the service catalog is populated,
 * but the platform never invokes the scanner without `serviceUUIDs` matching
 * our filter, so name fallback is safety net, not primary classifier.
 */
const classifyBleVendor = (
  serviceUUIDs: ReadonlyArray<string> | null | undefined,
  name: string | null | undefined,
): HardwareVendor | null => {
  if (serviceUUIDs && serviceUUIDs.length > 0) {
    const normalized = serviceUUIDs.map((u) => u.toLowerCase())
    if (normalized.includes(TREZOR_BLE_SERVICE_UUID)) return 'trezor'
    if (normalized.some((u) => (LEDGER_BLE_SERVICE_UUIDS as ReadonlyArray<string>).includes(u))) return 'ledger'
  }
  const lowerName = (name ?? '').toLowerCase()
  if (lowerName.startsWith('trezor')) return 'trezor'
  if (lowerName.startsWith('ledger') || lowerName.startsWith('nano')) return 'ledger'
  return null
}

/**
 * Request OS-level BLE runtime permissions.
 *
 * Android 12+: BLUETOOTH_SCAN + BLUETOOTH_CONNECT.
 * Android < 12: ACCESS_FINE_LOCATION (the legacy permission used to scope BLE scans).
 *
 * iOS does not have a runtime permissions API for Bluetooth — permission state
 * is observed via the `BleManager.state()` machinery in `bluetooth-state.native`,
 * so this is a no-op on iOS. The full readiness check (permission + adapter on)
 * belongs to `waitForBluetoothReady` from `bluetooth-state`.
 */
export const requestBLEPermissions = async (): Promise<boolean> => {
  if (platformIsAndroid) {
    if (typeof Platform.Version === 'number' && Platform.Version >= 31) {
      const granted = await PermissionsAndroid.requestMultiple([
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
      ])
      return (
        granted[PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN] === PermissionsAndroid.RESULTS.GRANTED &&
        granted[PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT] === PermissionsAndroid.RESULTS.GRANTED
      )
    }
    const granted = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION)
    return granted === PermissionsAndroid.RESULTS.GRANTED
  }
  // iOS / other native — adapter readiness is the source of truth.
  return true
}

/**
 * Start scanning for BLE hardware-wallet devices (Ledger + Trezor).
 *
 * Drives a vendor-agnostic scan directly through `react-native-ble-plx`
 * filtered by both Ledger and Trezor service UUIDs. Each emitted device is
 * tagged with its vendor so the connect UI can route to the correct
 * pairing flow. `TransportBLE.open(id)` still works against any Ledger
 * device ID surfaced here — the Ledger transport does its own GATT connect
 * and does not require a prior `TransportBLE.listen()` warmup.
 *
 * Permission and adapter-readiness checks are handled by the hardware
 * service before this function is called; this adapter only opens the
 * scan.
 *
 * Devices that aren't classifiable as Ledger or Trezor are dropped — the
 * service-UUID filter passed to `startDeviceScan` should prevent them
 * reaching us, but the name-based fallback guards against an empty
 * `serviceUUIDs` array on the first Android emission.
 */
export const startBLEScan = (onDevice: (device: BLEDevice) => void): BLEScanSubscription => {
  let unsubscribed = false
  const seenIds = new Set<string>()

  try {
    const manager = getBleManager()
    manager.startDeviceScan(ALL_BLE_SERVICE_UUIDS as string[], {allowDuplicates: false}, (error, device) => {
      if (unsubscribed) return
      if (error) {
        logger.error('BLE scan error', {origin: 'hardware.native', cause: error})
        return
      }
      if (!device || seenIds.has(device.id)) return

      const vendor: HardwareVendor | null = classifyBleVendor(device.serviceUUIDs, device.name)
      if (!vendor) return

      seenIds.add(device.id)
      const fallbackName = vendor === 'trezor' ? 'Trezor Device' : 'Ledger Device'
      const resolved: BLEDevice = {
        id: device.id,
        name: device.name ?? device.localName ?? fallbackName,
        ...(device.rssi !== null && device.rssi !== undefined ? {rssi: device.rssi} : {}),
        vendor,
      }
      onDevice(resolved)
    })
  } catch (error) {
    logger.warn('BLE scanning not available', {origin: 'hardware.native', cause: error})
    return {unsubscribe: () => {}}
  }

  return {
    unsubscribe: () => {
      if (unsubscribed) return
      unsubscribed = true
      try {
        getBleManager().stopDeviceScan()
      } catch (e) {
        logger.warn('Failed to stop BLE scan', {origin: 'hardware.native', cause: e})
      }
    },
  }
}

export const stopBLE = async (): Promise<void> => {
  // BLE cleanup is handled by individual transport instances
  // There's no global disconnect method on the transport class
}

// ============================================================================
// Hardware wallets over USB (Android host mode)
// ============================================================================

/** USB host mode is Android-only; iOS has no equivalent for either vendor. */
export const isHardwareUSBSupported = (): boolean => platformIsAndroid

type UsbScanHandlers = {
  onDevice: (device: {id: string; name: string; vendor: HardwareVendor}) => void
  onDeviceLost?: (id: string) => void
}

/**
 * Discover Trezors plugged in over USB, through the vendored ReactNativeUsb Expo
 * module. Owns the USB permission prompt, so a device reaching `onDevice` is one
 * the transport can actually open.
 */
const startTrezorUSBScan = ({onDevice, onDeviceLost}: UsbScanHandlers): ScanSubscription => {
  try {
    const subscription = startTrezorUsbScan({
      onDevice: (device) => onDevice({id: device.deviceName, name: device.name, vendor: 'trezor'}),
      ...(onDeviceLost ? {onDeviceLost} : {}),
      logger: {
        debug: (message) => logger.debug(message, {origin: 'hardware.native'}),
        warn: (message, cause) => logger.warn(message, {origin: 'hardware.native', cause}),
      },
    })
    return {unsubscribe: () => subscription.unsubscribe()}
  } catch (error) {
    // The Expo module is missing from the build (bare Metro run against an old
    // binary) — degrade rather than taking the pair screen down.
    logger.warn('Trezor USB scanning not available', {origin: 'hardware.native', cause: error})
    return {unsubscribe: () => {}}
  }
}

/**
 * Discover Ledgers plugged in over USB, through `@ledgerhq/react-native-hid`.
 *
 * `TransportHID.listen` replays an `add` for everything already attached and
 * then streams hot-plug, and its stream is pre-filtered to Ledger's USB vendor
 * id. Unlike the Trezor rail this does **not** prompt for permission — the
 * native `openDevice` does, at connect time — so a row appearing here is not yet
 * proof the app can open it.
 *
 * The row id encodes vendor/product (see `./ledger-usb-device`) because
 * `TransportHID.open` needs that pair, not the native descriptor object.
 */
const startLedgerUSBScan = ({onDevice, onDeviceLost}: UsbScanHandlers): ScanSubscription => {
  if (!isUSBHIDSupported() || !TransportHID.listen) return {unsubscribe: () => {}}

  let unsubscribed = false
  try {
    const subscription = TransportHID.listen({
      next: (event: {type: string; descriptor?: Record<string, unknown>; deviceModel?: {productName?: string}}) => {
        if (unsubscribed) return
        const vendorId = event.descriptor?.vendorId
        const productId = event.descriptor?.productId
        // Without both ids the row could not be reopened, so drop it rather than
        // render a device that cannot connect.
        if (typeof vendorId !== 'number' || typeof productId !== 'number') return

        const id = encodeLedgerUsbId({vendorId, productId})
        if (event.type === 'remove') {
          onDeviceLost?.(id)
          return
        }
        if (event.type !== 'add') return

        // `deviceModel.productName` is Ledger's own model name ("Nano X").
        const model = event.deviceModel?.productName?.trim()
        onDevice({
          id,
          name: model !== undefined && model.length > 0 ? model : 'Ledger',
          vendor: 'ledger',
        })
      },
      error: (error: Error) => {
        logger.warn('Ledger USB scan error', {origin: 'hardware.native', cause: error})
      },
      complete: () => {},
    })
    return {
      unsubscribe: () => {
        unsubscribed = true
        subscription.unsubscribe()
      },
    }
  } catch (error) {
    logger.warn('Ledger USB scanning not available', {origin: 'hardware.native', cause: error})
    return {unsubscribe: () => {}}
  }
}

/**
 * Discover every hardware wallet attached over USB.
 *
 * Trezor and Ledger arrive on two unrelated native rails, so this fans out to
 * both and merges them behind one subscription. A rail that is unavailable
 * contributes nothing instead of failing the other.
 */
export const startHardwareUSBScan = (handlers: UsbScanHandlers): ScanSubscription => {
  if (!platformIsAndroid) return {unsubscribe: () => {}}

  const subscriptions = [startTrezorUSBScan(handlers), startLedgerUSBScan(handlers)]
  return {
    unsubscribe: () => {
      for (const subscription of subscriptions) subscription.unsubscribe()
    },
  }
}

// ============================================================================
// USB HID (Android)
// ============================================================================

export const listUSBDevices = async (): Promise<USBDevice[]> => {
  if (!isUSBHIDSupported()) return []

  try {
    if (!TransportHID.list) return []
    const devices = await TransportHID.list()
    return devices.map((d: {deviceId: number; vendorId: number; productId: number; productName: string}) => ({
      id: d.deviceId?.toString() ?? `usb-${d.vendorId ?? 0}-${d.productId ?? 0}`,
      vendorId: d.vendorId ?? 0,
      productId: d.productId ?? 0,
      productName: d.productName ?? 'Ledger Device',
      descriptor: d, // Preserve native device object for TransportHID.open()
    }))
  } catch (error) {
    logger.warn('USB HID listing not available', {origin: 'hardware.native', cause: error})
    return []
  }
}

/**
 * Start scanning for USB HID Ledger devices via TransportHID.listen().
 *
 * Emits an `add` for everything already attached, then streams hot-plug. It does
 * **not** prompt for USB permission — verified in `ReactHIDModule.java`, where
 * `getDeviceList` reads the bus unpermitted and only `openDevice` calls
 * `requestPermission`. So a device emitted here is not yet openable.
 *
 * Superseded for pair-screen discovery by `startLedgerUSBScan`, which maps onto
 * `DetectedDevice`; this one exposes the raw native descriptor.
 */
export const startUSBScan = (
  onDevice: (device: USBDevice) => void,
  options?: {onError?: (error: Error) => void; onComplete?: () => void},
): ScanSubscription => {
  if (!isUSBHIDSupported()) {
    options?.onComplete?.()
    return {unsubscribe: () => {}}
  }

  let unsubscribed = false

  const startScan = async () => {
    try {
      if (unsubscribed) return () => {}

      const subscription = TransportHID.listen({
        next: (event: {type: string; descriptor: Record<string, unknown>}) => {
          if (!unsubscribed && event.type === 'add') {
            const d = event.descriptor
            const device: USBDevice = {
              id:
                (d.deviceId as number)?.toString() ??
                `usb-${(d.vendorId as number) ?? 0}-${(d.productId as number) ?? 0}`,
              vendorId: (d.vendorId as number) ?? 0,
              productId: (d.productId as number) ?? 0,
              productName: (d.productName as string) ?? 'Ledger Device',
              descriptor: d,
            }
            onDevice(device)
          }
        },
        error: (error: Error) => {
          console.error('USB HID scan error:', error)
          options?.onError?.(error)
        },
        complete: () => {
          options?.onComplete?.()
        },
      })

      return () => {
        unsubscribed = true
        subscription.unsubscribe()
      }
    } catch (error) {
      console.warn('USB HID scanning not available:', error)
      options?.onError?.(error instanceof Error ? error : new Error(String(error)))
      return () => {}
    }
  }

  let cleanup = () => {
    unsubscribed = true
  }
  startScan().then((fn) => {
    // If already unsubscribed during init, clean up the native listener immediately
    if (unsubscribed) {
      fn()
    } else {
      cleanup = fn
    }
  })

  return {
    unsubscribe: () => {
      unsubscribed = true
      cleanup()
    },
  }
}

/**
 * Create a Ledger transport factory for a specific USB HID device.
 * The descriptor must be the native device object from listUSBDevices/listen.
 */
export const createUSBTransportFactoryForDevice = async (descriptor: unknown): Promise<LedgerTransportFactory> => {
  type DeviceObj = {vendorId: number; productId: number}

  return {
    create: async () => TransportHID.open(descriptor as DeviceObj),
    open: async (desc: unknown) => TransportHID.open((desc ?? descriptor) as DeviceObj),
    list: async () => [],
    listen: (observer: {
      next: (event: {type: 'add' | 'remove'; descriptor: unknown}) => void
      error: (error: Error) => void
      complete: () => void
    }) => TransportHID.listen(observer),
  }
}

// ============================================================================
// Transport Factory
// ============================================================================

/**
 * Create a Ledger transport factory for native platforms.
 *
 * `prefer` lets the caller force a specific transport when the original
 * pairing is known — necessary on Android, where the default BLE-first
 * order would otherwise pick BLE for a USB-paired Ledger and fail.
 */
export const createLedgerTransportFactory = (opts?: {
  readonly prefer?: 'usb' | 'ble'
}): Effect.Effect<LedgerTransportFactory, Error> => {
  if (opts?.prefer === 'usb' && isUSBHIDSupported()) {
    return createUSBHIDTransportFactory()
  }
  if (opts?.prefer === 'ble' && isBLEAvailable()) {
    return createBLETransportFactory()
  }
  if (isBLEAvailable()) {
    return createBLETransportFactory()
  }
  if (isUSBHIDSupported()) {
    return createUSBHIDTransportFactory()
  }
  return Effect.fail(new Error('No compatible native transport available'))
}

/**
 * Open a BLE transport to a specific device.
 */
export const openLedgerBLETransport = openBLETransport

/**
 * Open a USB HID transport to a specific device.
 */
export const openLedgerUSBTransport = openUSBHIDTransport

/**
 * Create a Ledger transport factory for a specific BLE device.
 * This creates a factory that will connect to the given device ID.
 */
export const createBLETransportFactoryForDevice = async (deviceId: string): Promise<LedgerTransportFactory> => {
  // GATT connection timeout — without this TransportBLE.open() relies on the OS-level
  // BLE timeout (30s on iOS, varies on Android) which is too long for retry loops.
  const BLE_CONNECT_TIMEOUT_MS = 10_000

  return {
    create: async () => {
      return TransportBLE.open(deviceId, BLE_CONNECT_TIMEOUT_MS)
    },
    open: async (descriptor: unknown) => {
      const id = typeof descriptor === 'string' && descriptor.length > 0 ? descriptor : deviceId
      return TransportBLE.open(id, BLE_CONNECT_TIMEOUT_MS)
    },
    list: async () => [],
    listen: (observer: {
      next: (event: {type: 'add' | 'remove'; descriptor: unknown}) => void
      error: (error: Error) => void
      complete: () => void
    }) => TransportBLE.listen(observer),
    forceBleDisconnect: async (id: string) => {
      // biome-ignore lint/suspicious/noExplicitAny: SDK static, types omit it on some builds
      const fn = (TransportBLE as any).disconnectDevice
      if (typeof fn !== 'function') return
      await fn.call(TransportBLE, id)
    },
  }
}

// ============================================================================
// Web Picker / Permission Stubs (not available on native)
// ============================================================================

export const TREZOR_USB_FILTERS: ReadonlyArray<{vendorId: number; productId?: number}> = []

export const requestWebHIDPermission = async () => []
export const getPermittedWebHIDDevices = async () => []

export const requestWebUSBPermissionForTrezor = async (): Promise<unknown> => {
  throw new Error('WebUSB is only available on web')
}
export const getPermittedWebUSBTrezorDevices = async (): Promise<
  ReadonlyArray<{vendorId: number; productId: number; productName: string}>
> => []

// No-op on native — BLE/USB plug events are handled via transport events
export const onWebDeviceConnect =
  (_callback: (info: {vendorId: number; productId: number; productName: string}) => void): (() => void) =>
  () => {}
export const onWebDeviceDisconnect =
  (_callback: (info: {vendorId: number; productId: number; opened: boolean}) => void): (() => void) =>
  () => {}
