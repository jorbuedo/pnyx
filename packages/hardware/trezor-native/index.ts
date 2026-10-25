/**
 * Native transports for Trezor hardware wallets on React Native.
 *
 * Provides USB (Android) and Bluetooth (Android/iOS) transports
 * vendored from trezor-suite's unpublished workspace packages.
 *
 * @module
 */

export {bluetoothManager} from './bluetooth/bluetooth-manager'
export type {BluetoothDevice, BluetoothManagerErrorCode, DeviceConnectionStatus} from './bluetooth/types'
export {BluetoothManagerError} from './bluetooth/types'
export {createNativeBluetoothTransport} from './create-bluetooth-transport'
export {createNativeUsbTransport} from './create-usb-transport'
export type {DetectedUsbTrezor, UsbScanHandlers, UsbScanSubscription} from './usb/scan'
export {isUsbScanSupported, startTrezorUsbScan} from './usb/scan'
