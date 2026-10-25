/**
 * Whether the PIN gate asks — pure.
 *
 * The three modes trade routine friction against which coercion they defend:
 *
 * - `everyUnlock` / `coldStart` defend a **surprise** seizure, at the cost of
 *   asking often.
 * - `armed` costs nothing routinely but only defends coercion the user saw
 *   coming and armed for.
 *
 * `coldStart` is the recommended default: the app already forces re-auth on
 * every cold start (`useLockScreen`), so the PIN screen appears at a moment
 * that is already routine and discloses nothing by appearing.
 *
 * @module
 */

/** When the gate asks for a PIN. */
export type PinMode = 'everyUnlock' | 'coldStart' | 'armed'

export const PIN_MODES: readonly PinMode[] = ['everyUnlock', 'coldStart', 'armed']

/** Parse a stored mode; anything unrecognised is treated as absent by the caller. */
export const parsePinMode = (raw: unknown): PinMode | undefined =>
  PIN_MODES.includes(raw as PinMode) ? (raw as PinMode) : undefined

export type PinGateInput = {
  /** False when no PIN is configured at all — the gate never asks. */
  readonly configured: boolean
  readonly mode: PinMode
  /** True on a fresh process start, false on a warm re-lock. */
  readonly isColdStart: boolean
  /** True when the user manually locked and the next open must ask. */
  readonly isArmed: boolean
}

/**
 * Does the gate ask for a PIN right now?
 *
 * `isArmed` overrides every mode: a manual lock means ask, full stop. Otherwise
 * the mode decides.
 */
export const isPinRequired = ({configured, mode, isColdStart, isArmed}: PinGateInput): boolean => {
  if (!configured) return false
  if (isArmed) return true

  switch (mode) {
    case 'everyUnlock':
      return true
    case 'coldStart':
      return isColdStart
    case 'armed':
      return false
  }
}
