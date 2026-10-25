/**
 * Trezor discovery over USB (Android host mode).
 *
 * Unlike BLE there is nothing to scan for — the OS already knows what is plugged
 * in. The work is permission: `getDevices()` hides devices the app has no USB
 * permission for, so discovery enumerates via `listDevices()` (which does not),
 * prompts for anything unpermitted, and emits a device only once access is
 * actually held — a row the user cannot connect to is worse than no row.
 *
 * The native module import is deferred to call time: `requireNativeModule`
 * throws at module scope when the ReactNativeUsb Expo module isn't compiled into
 * the running binary, which would take down every importer rather than just
 * disabling USB (same reason `../create-usb-transport` defers).
 *
 * Filtering and naming rules live in `./trezor-usb-devices` so they stay
 * testable without the native module.
 *
 * @module
 */

import {Platform} from 'react-native'
import type {DetectedUsbTrezor} from './trezor-usb-devices'
import {describeUsbDevices, isTrezorUsbDevice, toDetectedUsbTrezors, trezorUsbDeviceName} from './trezor-usb-devices'

export type {DetectedUsbTrezor}

export type UsbScanLogger = {
  readonly debug?: (message: string) => void
  readonly warn?: (message: string, cause?: unknown) => void
}

export type UsbScanSubscription = {
  readonly unsubscribe: () => void
}

export type UsbScanHandlers = {
  readonly onDevice: (device: DetectedUsbTrezor) => void
  /** Fired when a previously-emitted Trezor is unplugged. */
  readonly onDeviceLost?: (deviceName: string) => void
  readonly logger?: UsbScanLogger
}

/** USB host mode is Android-only; iOS and web have no equivalent rail. */
export const isUsbScanSupported = (): boolean => Platform.OS === 'android'

/**
 * Enumerate plugged-in Trezors and keep watching for hot-plug until
 * unsubscribed. Safe to call on any platform, and safe when the native module
 * is missing — both degrade to yielding no devices.
 */
export const startTrezorUsbScan = ({onDevice, onDeviceLost, logger}: UsbScanHandlers): UsbScanSubscription => {
  if (!isUsbScanSupported()) return {unsubscribe: () => {}}

  let stopped = false
  const emitted = new Set<string>()
  // Asking for permission pops a system dialog, so never ask twice for the same
  // port within one scan even if enumeration and a plug event race.
  const asked = new Set<string>()
  const teardown: Array<() => void> = []

  const emit = (device: DetectedUsbTrezor) => {
    if (stopped || emitted.has(device.deviceName)) return
    emitted.add(device.deviceName)
    onDevice(device)
  }

  const run = async () => {
    const {listDevices, onDeviceConnected, onDeviceDisconnect, requestPermission} = await import(
      '../react-native-usb/src/index'
    )
    if (stopped) return

    // A device plugged in mid-scan, and the re-emit that follows a permission grant.
    const connectSub = onDeviceConnected((event) => {
      const device = event.device
      if (stopped || !device || !isTrezorUsbDevice(device)) return
      emit({deviceName: device.deviceName, name: trezorUsbDeviceName(device), hasPermission: true})
    })
    const disconnectSub = onDeviceDisconnect((event) => {
      const device = event.device
      if (stopped || !device) return
      emitted.delete(device.deviceName)
      asked.delete(device.deviceName)
      if (isTrezorUsbDevice(device)) onDeviceLost?.(device.deviceName)
    })
    teardown.push(
      () => connectSub.remove(),
      () => disconnectSub.remove(),
    )

    const ensurePermission = async (device: DetectedUsbTrezor) => {
      if (device.hasPermission) {
        emit(device)
        return
      }
      if (asked.has(device.deviceName)) return
      asked.add(device.deviceName)

      logger?.debug?.(`usb: requesting permission for ${device.deviceName}`)
      const granted = await requestPermission(device.deviceName)
      if (stopped) return
      if (!granted) {
        logger?.warn?.(`usb: permission denied for ${device.deviceName}`)
        return
      }
      emit({...device, hasPermission: true})
    }

    const attached = await listDevices()
    if (stopped) return
    const trezors = toDetectedUsbTrezors(attached)
    logger?.debug?.(
      `usb: ${attached.length} device(s) attached, ${trezors.length} Trezor(s) — ${describeUsbDevices(attached)}`,
    )
    await Promise.all(trezors.map(ensurePermission))
  }

  run().catch((error) => {
    logger?.warn?.('usb: discovery unavailable', error)
  })

  return {
    unsubscribe: () => {
      if (stopped) return
      stopped = true
      for (const off of teardown) off()
      teardown.length = 0
    },
  }
}
