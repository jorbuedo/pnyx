/**
 * Which name a paired hardware device shows.
 *
 * Discovery names differ by transport: a BLE advertisement carries the user-set
 * label, but a USB string descriptor is a fixed vendor string ("Trezor"), so the
 * label only becomes knowable once the device answers `GetFeatures`. Preferring
 * that label makes the two transports agree instead of a cabled device importing
 * as a generic "Trezor".
 *
 * @module
 */

/**
 * Resolve the display name for a connected device.
 *
 * The device's own label wins when it has one; otherwise the discovery name
 * stands. Both are trimmed, and a blank of either is treated as absent — never
 * substituted with a placeholder, so an unlabelled device keeps whatever the
 * scan legitimately reported.
 */
export const resolveDeviceDisplayName = ({
  scanName,
  deviceLabel,
}: {
  readonly scanName: string
  readonly deviceLabel?: string | null | undefined
}): string => {
  const label = deviceLabel?.trim()
  if (label !== undefined && label.length > 0) return label
  return scanName.trim()
}
