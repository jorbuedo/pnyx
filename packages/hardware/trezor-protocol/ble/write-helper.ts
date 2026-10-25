/**
 * Shared BLE write helper — throttling and padding.
 *
 * Both native and web BLE managers delegate to this helper to ensure
 * consistent write behavior across platforms:
 * - Throttle: minimum 10ms gap between writes (device drops faster packets)
 * - Pad: all writes padded to 244 bytes (firmware ignores shorter frames)
 */

import {BLE_CHUNK_SIZE, BLE_WRITE_MIN_GAP_MS} from './constants'

export const createBleWriteHelper = () => {
  const lastWriteTimestamp: Record<string, number> = {}

  /**
   * Throttle and pad a BLE write.
   *
   * Enforces a minimum gap between consecutive writes, then pads the
   * message to BLE_CHUNK_SIZE. Returns the padded buffer ready for
   * the platform-specific write call.
   */
  const prepareWrite = async (deviceId: string, message: Uint8Array): Promise<Uint8Array> => {
    const now = Date.now()
    const lastWrite = lastWriteTimestamp[deviceId] ?? 0
    const elapsed = now - lastWrite
    if (elapsed < BLE_WRITE_MIN_GAP_MS) {
      await new Promise<void>((resolve) => setTimeout(resolve, BLE_WRITE_MIN_GAP_MS - elapsed))
    }
    lastWriteTimestamp[deviceId] = Date.now()

    const padded = new Uint8Array(Math.max(message.length, BLE_CHUNK_SIZE))
    padded.set(message)
    return padded
  }

  /** Clean up throttle state for a device (call on disconnect). */
  const clearDevice = (deviceId: string) => {
    delete lastWriteTimestamp[deviceId]
  }

  return {prepareWrite, clearDevice}
}
