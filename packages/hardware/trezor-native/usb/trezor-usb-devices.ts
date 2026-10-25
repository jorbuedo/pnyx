/**
 * Pure identification of Trezor devices among the attached USB devices.
 *
 * Kept free of the native module and `react-native` so the filtering and naming
 * rules are directly testable; the scan wiring lives in `./scan`.
 *
 * @module
 */

import {T1_HID_PRODUCT, T1_HID_VENDOR, TREZOR_USB_DESCRIPTORS, WEBUSB_BOOTLOADER_PRODUCT} from './constants'

/** The subset of the WebUSB device shape identification needs. */
export type UsbDeviceIdentity = {
  readonly vendorId: number
  readonly productId: number
  readonly deviceName: string
  readonly productName?: string | undefined
  readonly hasPermission?: boolean | undefined
}

/** A Trezor found on the USB bus, ready for the pair screen. */
export type DetectedUsbTrezor = {
  /** Android device path (`/dev/bus/usb/001/002`) — stable per port, not per device. */
  readonly deviceName: string
  readonly name: string
  /** False when the app holds no USB permission for it yet. */
  readonly hasPermission: boolean
}

const WEBUSB_VENDOR = 0x1209

export const isTrezorUsbDevice = (device: {readonly vendorId: number; readonly productId: number}): boolean =>
  TREZOR_USB_DESCRIPTORS.some((d) => d.vendorId === device.vendorId && d.productId === device.productId)

/**
 * Display name for a Trezor on USB.
 *
 * Prefers the descriptor string the device itself reports. The per-VID/PID
 * fallbacks are the documented meaning of those pairs, not invented labels —
 * Android returns a null `productName` for a device the app has no permission
 * for, which is exactly when the pair screen still has to show a row.
 */
export const trezorUsbDeviceName = (device: UsbDeviceIdentity): string => {
  const reported = device.productName?.trim()
  if (reported !== undefined && reported.length > 0) return reported
  if (device.vendorId === T1_HID_VENDOR && device.productId === T1_HID_PRODUCT) return 'Trezor One'
  if (device.vendorId === WEBUSB_VENDOR && device.productId === WEBUSB_BOOTLOADER_PRODUCT) return 'Trezor (Bootloader)'
  return 'Trezor'
}

/** Filter attached USB devices down to Trezors, in bus order. */
export const toDetectedUsbTrezors = (devices: readonly UsbDeviceIdentity[]): readonly DetectedUsbTrezor[] =>
  devices.filter(isTrezorUsbDevice).map((device) => ({
    deviceName: device.deviceName,
    name: trezorUsbDeviceName(device),
    hasPermission: device.hasPermission === true,
  }))

/**
 * One-line `vid:pid` summary of what is on the bus, for the discovery log.
 *
 * "0 Trezors found" is unactionable on its own — a Trezor in bootloader mode, a
 * device that re-enumerated under a different product id, and a plugged charger
 * are indistinguishable without the ids. Hex-padded so it can be compared
 * against `TREZOR_USB_DESCRIPTORS` by eye.
 */
export const describeUsbDevices = (devices: readonly UsbDeviceIdentity[]): string =>
  devices.length === 0
    ? 'none'
    : devices
        .map((d) => {
          const vid = d.vendorId.toString(16).padStart(4, '0')
          const pid = d.productId.toString(16).padStart(4, '0')
          const product = d.productName?.trim()
          return `${vid}:${pid}${product !== undefined && product.length > 0 ? ` (${product})` : ''}`
        })
        .join(', ')
