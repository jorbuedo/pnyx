/**
 * Which UR types the scanner assembles, and where a completed sequence goes.
 *
 * Both halves live together and the mapping is **total**, so a type added to the accept list
 * without a destination is a compile error rather than a scan that completes and navigates
 * nowhere. The alternative — a list here and a ternary there — is the shape that lets the two
 * drift; see the `a-card-is-not-a-gate` case, where exactly that happened to two link switches.
 *
 * @module
 */

import {
  UR_TYPE_QR_HARDWARE_CALL,
  UR_TYPE_SIGN_CIP8_DATA_REQUEST,
  UR_TYPE_SIGN_DATA_REQUEST,
  UR_TYPE_SIGN_REQUEST,
  UR_TYPE_SIGN_TX_HASH_REQUEST,
} from '@pnyx/ur'

/**
 * Two of these are accepted only so they can be refused *by name* on the screen that owns them.
 *
 * `cardano-sign-tx-hash-request` (2212) carries a bare hash with nothing to review.
 * `cardano-sign-data-request` (2205) asks for a signature over arbitrary bytes, which is a
 * transaction witness in disguise. Dropping either at the scanner would tell the user only that
 * their other wallet produced something unrecognised, when the truth is that Pnyx will never sign
 * it and they are owed the reason.
 */
export const ACCEPTED_UR_TYPES = [
  UR_TYPE_SIGN_REQUEST,
  UR_TYPE_SIGN_TX_HASH_REQUEST,
  UR_TYPE_SIGN_DATA_REQUEST,
  UR_TYPE_SIGN_CIP8_DATA_REQUEST,
  UR_TYPE_QR_HARDWARE_CALL,
] as const

export type AcceptedUrType = (typeof ACCEPTED_UR_TYPES)[number]

/**
 * A `Record` over the union, not a lookup with a fallback: TypeScript requires every accepted type
 * to name a screen, which is the whole point of keeping the two in one file.
 */
const DESTINATION: Record<AcceptedUrType, string> = {
  [UR_TYPE_SIGN_REQUEST]: '/wallet/air-gap-request',
  [UR_TYPE_SIGN_TX_HASH_REQUEST]: '/wallet/air-gap-request',
  // A message request is not a transaction: different review, different signing verb, different
  // reply type. Routing it to the transaction screen would only get it refused.
  [UR_TYPE_SIGN_DATA_REQUEST]: '/wallet/air-gap-message',
  [UR_TYPE_SIGN_CIP8_DATA_REQUEST]: '/wallet/air-gap-message',
  // Not a signing request at all — a companion asking which keys to export.
  [UR_TYPE_QR_HARDWARE_CALL]: '/wallet/air-gap-export',
}

const ACCEPTED = new Set<string>(ACCEPTED_UR_TYPES)

export const isAcceptedUrType = (urType: string): urType is AcceptedUrType => ACCEPTED.has(urType)

/**
 * The route for a completed scan.
 *
 * Returns `null` for a type the scanner never agreed to assemble, rather than guessing a screen —
 * reaching this with an unaccepted type means the session and this module disagree, and navigating
 * anyway would hand a screen a payload it has no decision path for.
 */
export const routeForScannedUr = (urType: string, scanId: string): string | null =>
  isAcceptedUrType(urType) ? `${DESTINATION[urType]}?scan=${scanId}` : null
