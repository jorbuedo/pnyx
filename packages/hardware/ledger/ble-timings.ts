/**
 * Per-model BLE timing constants for the Ledger app-switch sequence.
 *
 * Background: switching apps over BLE requires two GATT drop/reconnect cycles
 * within a few hundred milliseconds — close-app → BOLOS reboot → open-app →
 * new app initialises → BLE advertising restarts. Older Ledger hardware
 * (Nano X, 2019) is materially slower than the newer Cortex-M33 devices
 * (Stax, Flex, Gen 5) at completing this sequence.
 *
 * Tuning the same timings for every model means either:
 *  - too short → Nano X reconnect fires before advertising restarts, BLE
 *    reports the device as disconnected, the app-switch surfaces a
 *    `DeviceNotConnectedError` to the user.
 *  - too long → Stax/Flex/Gen 5 users pay an extra ~2 s per switch for no
 *    benefit.
 *
 * Use {@link getBleSwitchTimings} at every site that previously hard-coded
 * the timing so the values scale with the device. Empirically derived from
 * a Sentry trace (Pixel 10 Pro + Nano X over BLE, 100%
 * failure rate on Cardano → Ethereum switch with the default 500/1000 ms).
 *
 * @module
 */

import type {LedgerModel} from '../types.js'

/**
 * BLE timings for one specific Ledger model on the app-switch path.
 */
export type LedgerBleSwitchTimings = {
  /**
   * Delay between the close-app APDU and the open-app APDU. Gives the device
   * time to settle on the BOLOS dashboard before we ask it to launch the
   * next app. Too short on Nano X: the open-app APDU may race the dashboard
   * boot and be silently dropped.
   */
  readonly settleMs: number
  /**
   * Delay between the open-app APDU send (which drops the BLE GATT) and the
   * subsequent `ensureConnected()` attempt. Gives the device time to finish
   * loading the new app and restart BLE advertising. Too short on Nano X:
   * `ensureConnected()`'s `waitForBleReady` gate fails fast before
   * advertising resumes, surfacing `DeviceNotConnectedError`.
   */
  readonly preReconnectMs: number
}

const DEFAULT_TIMINGS: LedgerBleSwitchTimings = {
  settleMs: 500,
  preReconnectMs: 1000,
}

const NANO_X_TIMINGS: LedgerBleSwitchTimings = {
  settleMs: 1500,
  preReconnectMs: 3000,
}

const TIMINGS_BY_MODEL: Partial<Record<LedgerModel, LedgerBleSwitchTimings>> = {
  nanoX: NANO_X_TIMINGS,
}

/**
 * Resolve the BLE app-switch timing table for a given Ledger model. Falls
 * back to {@link DEFAULT_TIMINGS} when the model is `null` (not yet
 * detected) or not explicitly listed.
 *
 * @param model - The detected Ledger model, or `null` when unknown.
 */
export const getBleSwitchTimings = (model: LedgerModel | null | undefined): LedgerBleSwitchTimings =>
  model != null && TIMINGS_BY_MODEL[model] !== undefined ? TIMINGS_BY_MODEL[model] : DEFAULT_TIMINGS
