/**
 * Web Bluetooth transport for Trezor hardware wallets in browser contexts.
 *
 * Provides a BLE transport using the Web Bluetooth API for fullscreen
 * browser tabs where navigator.bluetooth is available.
 *
 * @module
 */

export {createWebBluetoothTransport} from './create-web-bluetooth-transport'
export {webBluetoothManager} from './web-bluetooth-manager'
