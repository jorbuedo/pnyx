/**
 * Shared BLE constants for Trezor transport.
 *
 * Used by both native (react-native-ble-plx) and web (Web Bluetooth API)
 * implementations. These values are dictated by the Trezor firmware.
 */

/** BLE packet size expected by Trezor firmware. Short writes (e.g. 9-byte ACKs) are silently ignored. */
export const BLE_CHUNK_SIZE = 244

/** Minimum gap between consecutive BLE writes (ms). Faster writes cause packet loss. */
export const BLE_WRITE_MIN_GAP_MS = 10

/** Trezor BLE service and characteristic UUIDs. */
export const TrezorService = {
  uuid: '8c000001-a59b-4d58-a9ad-073df69fa1b1',
  characteristics: {
    writeUuid: '8c000002-a59b-4d58-a9ad-073df69fa1b1',
    notifyUuid: '8c000003-a59b-4d58-a9ad-073df69fa1b1',
    pushUuid: '8c000004-a59b-4d58-a9ad-073df69fa1b1',
  },
} as const

/** Standard BLE battery service UUIDs. */
export const BatteryService = {
  uuid: '0000180f-0000-1000-8000-00805f9b34fb',
  characteristics: {
    batteryLevelUuid: '00002a19-0000-1000-8000-00805f9b34fb',
  },
} as const
