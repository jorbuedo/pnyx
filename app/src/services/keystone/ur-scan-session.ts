/**
 * An accumulating UR scan.
 *
 * The camera hands us one decoded string per frame, most of them repeats and some of them not
 * URs at all. This owns the state that turns that stream into one message: which UR type the
 * sequence committed to, the fountain decoder, and how far along it is.
 *
 * Pure and React-free so the state machine can be tested without a camera. The hook wrapping it
 * adds nothing but `useState`.
 *
 * @module
 */

import {type DecoderProgress, decodeUr, type FountainDecoder, fountainDecoder, isMultiPart, type Ur} from '@pnyx/ur'

export type UrScanState =
  /** Nothing scanned yet. */
  | {readonly kind: 'idle'}
  /** A sequence is in progress. `urType` is fixed by the first frame accepted. */
  | {readonly kind: 'scanning'; readonly urType: string; readonly progress: DecoderProgress}
  | {readonly kind: 'complete'; readonly ur: Ur}
  /**
   * `recoverable` means keep the camera running: the frame was noise, a partial read, or an
   * unrelated QR that happened to be in shot. When it is false the session is wedged on purpose
   * and needs a reset — the user is filming the wrong thing, and silently ignoring frames would
   * look like the scanner had frozen.
   */
  | {readonly kind: 'error'; readonly message: string; readonly recoverable: boolean}

export type UrScanSession = {
  /** Feed one decoded QR payload. Returns the state after it was considered. */
  readonly accept: (scanned: string) => UrScanState
  readonly state: () => UrScanState
  readonly reset: () => void
}

export type UrScanOptions = {
  /**
   * UR types this scan will accept. A type outside the list fails unrecoverably rather than being
   * ignored, because the user is pointing the camera at something real that we will not act on —
   * a `crypto-psbt` from a Bitcoin wallet, say — and saying so is more useful than a stalled bar.
   */
  readonly acceptedTypes?: readonly string[]
}

const IDLE: UrScanState = {kind: 'idle'}

export const urScanSession = (options: UrScanOptions = {}): UrScanSession => {
  const accepted = options.acceptedTypes
  let decoder: FountainDecoder = fountainDecoder()
  let urType: string | undefined
  let state: UrScanState = IDLE

  const reset = (): void => {
    decoder = fountainDecoder()
    urType = undefined
    state = IDLE
  }

  const fail = (message: string, recoverable: boolean): UrScanState => {
    state = {kind: 'error', message, recoverable}
    return state
  }

  const accept = (scanned: string): UrScanState => {
    // Once complete, further frames are the same code still on screen. Stay complete rather than
    // reporting them as errors.
    if (state.kind === 'complete') return state

    const parsed = decodeUr(scanned)
    if (!parsed.ok) {
      // Not a UR, or a mis-read frame. Recoverable: the next frame is very likely fine.
      return fail(parsed.error.kind, true)
    }

    const ur = parsed.value
    if (accepted !== undefined && !accepted.includes(ur.type)) {
      return fail(`unsupported:${ur.type}`, false)
    }
    if (urType !== undefined && ur.type !== urType) {
      // Mixing two sequences would assemble bytes from different messages.
      return fail(`type-changed:${urType}->${ur.type}`, false)
    }
    urType = ur.type

    if (!isMultiPart(ur)) {
      state = {kind: 'complete', ur}
      return state
    }

    const result = decoder.receivePart(ur.cbor)
    switch (result.kind) {
      case 'complete':
        state = {kind: 'complete', ur: {type: ur.type, cbor: result.message}}
        return state
      case 'rejected':
        // A part from a different message is fatal; a malformed one is not.
        return fail(result.reason, !result.fatal)
      default:
        state = {kind: 'scanning', urType: ur.type, progress: decoder.progress()}
        return state
    }
  }

  return {accept, state: () => state, reset}
}
