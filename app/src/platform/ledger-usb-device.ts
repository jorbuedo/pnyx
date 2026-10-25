/**
 * Encoding for a Ledger reached over USB HID.
 *
 * `DetectedDevice.id` is a string, but `TransportHID.open()` wants
 * `{vendorId, productId}`. Both are plain numbers, so the pair round-trips
 * through the id instead of the platform layer keeping a side map of
 * non-serializable native descriptors keyed by device.
 *
 * Pure — no `react-native`, no native module — so the round-trip is testable.
 *
 * @module
 */

/** Marks an id as a Ledger-over-USB handle rather than a BLE peripheral id. */
const LEDGER_USB_ID_PREFIX = 'ledger-usb'

export type LedgerUsbHandle = {
  readonly vendorId: number
  readonly productId: number
}

export const encodeLedgerUsbId = ({vendorId, productId}: LedgerUsbHandle): string =>
  `${LEDGER_USB_ID_PREFIX}:${vendorId}:${productId}`

/**
 * Recover the vendor/product pair from an id, or null when the id is not a
 * Ledger USB handle (a BLE peripheral id, a Trezor device path, anything else).
 *
 * Returns null rather than a partial guess: a wrong pair would open a different
 * device, so an unparseable id must fall through to the caller's other transport
 * rather than silently becoming `{vendorId: 0}`.
 */
export const decodeLedgerUsbId = (id: string): LedgerUsbHandle | null => {
  const parts = id.split(':')
  if (parts.length !== 3) return null
  const [prefix, vendor, product] = parts
  if (prefix !== LEDGER_USB_ID_PREFIX) return null

  const vendorId = Number(vendor)
  const productId = Number(product)
  if (!Number.isInteger(vendorId) || !Number.isInteger(productId)) return null
  // `Number('')` is 0 and an integer, so an empty segment would otherwise pass.
  if (vendor?.length === 0 || product?.length === 0) return null

  return {vendorId, productId}
}

export const isLedgerUsbId = (id: string): boolean => decodeLedgerUsbId(id) !== null
