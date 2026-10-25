/**
 * What a completed scan turned out to be.
 *
 * The UR type is the only thing that says how to read the payload, so classification happens
 * here — once — rather than being re-derived by each screen.
 *
 * @module
 */

import type {Ur} from '../ur.js'
import {
  type CardanoSignRequest,
  decodeCardanoSignRequest,
  UR_TYPE_SIGN_REQUEST,
  UR_TYPE_SIGN_TX_HASH_REQUEST,
} from './cardano.js'
import {decodeQrHardwareCall, type QrHardwareCall, UR_TYPE_QR_HARDWARE_CALL} from './hardware-call.js'

export type ScannedRequest =
  | {readonly kind: 'cardano-sign-request'; readonly request: CardanoSignRequest}
  /**
   * A companion wallet asking which keys to export. Not a signing request at all — it is answered
   * with an account export, so a screen must route it somewhere else entirely.
   */
  | {readonly kind: 'qr-hardware-call'; readonly call: QrHardwareCall}
  /**
   * `cardano-sign-tx-hash-request` (2212) carries a bare hash. Refused rather than warned about:
   * there is nothing for a human to review, so a review screen for it would assert a safety the
   * user does not have. See `docs/mobile-shell-plan.md` item 29.
   */
  | {readonly kind: 'refused-tx-hash-only'}
  | {readonly kind: 'unsupported'; readonly urType: string}
  | {readonly kind: 'malformed'; readonly urType: string; readonly detail: string}

export const classifyScannedUr = (ur: Ur): ScannedRequest => {
  switch (ur.type) {
    case UR_TYPE_SIGN_REQUEST: {
      const decoded = decodeCardanoSignRequest(ur.cbor)
      return decoded.ok
        ? {kind: 'cardano-sign-request', request: decoded.value}
        : {kind: 'malformed', urType: ur.type, detail: decoded.error}
    }
    case UR_TYPE_QR_HARDWARE_CALL: {
      const decoded = decodeQrHardwareCall(ur.cbor)
      return decoded.ok
        ? {kind: 'qr-hardware-call', call: decoded.value}
        : {kind: 'malformed', urType: ur.type, detail: decoded.error}
    }
    case UR_TYPE_SIGN_TX_HASH_REQUEST:
      return {kind: 'refused-tx-hash-only'}
    default:
      return {kind: 'unsupported', urType: ur.type}
  }
}
