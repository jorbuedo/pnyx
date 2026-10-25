/**
 * Decides which camera reads reach `onScan`, shared by the native and web scanners so the
 * two surfaces cannot drift.
 *
 * A single-shot scan (an address, a backup blob) wants exactly one delivery and nothing after
 * it. An animated multi-part QR — a Keystone UR — is the opposite: it only completes if every
 * frame the camera resolves is delivered. The camera resolves the *same* frame many times over
 * (a 60fps sensor against a ~2fps animation), so continuous mode drops a read that repeats the
 * one before it rather than handing the decoder work it will discard.
 *
 * @module
 */

export type ScanGate = {
  /** A single-shot scan has fired; nothing more is delivered. */
  readonly latched: boolean
  /** The last delivered payload, to recognise a repeat of the frame still in front of the lens. */
  readonly lastData: string | null
}

export const initialScanGate: ScanGate = {latched: false, lastData: null}

export type ScanGateStep = {
  readonly gate: ScanGate
  readonly deliver: boolean
}

/** Admit or drop one camera read, returning the gate to carry into the next. */
export const admitScan = (gate: ScanGate, data: string, continuous: boolean): ScanGateStep => {
  if (gate.latched) return {gate, deliver: false}
  if (continuous && data === gate.lastData) return {gate, deliver: false}
  return {gate: {latched: !continuous, lastData: data}, deliver: true}
}
