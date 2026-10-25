/**
 * Whether this device's identity is actually usable — a real signal, not `session !== undefined`.
 *
 * **The gap this closes.** `identity` (the persisted `{pnyxId, network}`) is written during onboarding
 * *before any network call*, deliberately, so avatars render offline. So it says nothing about whether
 * the identity's row reached the chain. `IdScreen` branched on it and therefore showed a complete,
 * copyable, shareable identity to a device whose row was never published — no indication, no way to
 * retry. Registration state appeared nowhere in the UI at all; the only trace was a `logger.warn`.
 *
 * **Three states, because "we have not established it" is not "no".** Collapsing `unknown` into
 * `unregistered` would tell a user their identity failed whenever they happened to be offline, which
 * is the same class of lie in the other direction.
 *
 * The signal is durable rather than session-shaped: `identity-registration-cache.ts` records that a
 * login once succeeded against this row — end-to-end proof it exists and is readable — and that
 * outlives the JWT. A live session is stronger still. Neither reads the chain, which is the point:
 * this renders on a tab, and the authoritative read is a marker query plus a ~20 kB ledger download.
 *
 * @module
 */

import type {SignInFailure} from './pnyx-session'

export type IdentityRegistrationState =
  /** No identity on this device. Onboarding has not run, or it was signed out. */
  | 'no-identity'
  /** Signed in right now — the service verified a challenge against the row's `authPub`. */
  | 'active'
  /** No live session, but a previous login proved the row exists. Offline, or the token lapsed. */
  | 'registered'
  /** Positive evidence the identity cannot log in: an attempt was made and the service refused it. */
  | 'unregistered'
  /** Nothing established yet — no session, no prior success, no failed attempt to learn from. */
  | 'unknown'

export type IdentityRegistrationInputs = {
  readonly hasIdentity: boolean
  readonly hasSession: boolean
  /** From {@link isIdentityRegistered} — a prior login succeeded for this network + contract. */
  readonly cachedRegistered: boolean
  /** The last sign-in attempt's failure bucket, or `undefined` if none has failed. */
  readonly lastFailure: SignInFailure | undefined
}

/**
 * Resolve the state.
 *
 * Order matters. A live session wins over everything — it is the strongest evidence available. The
 * durable flag comes next, so going offline degrades to `registered` rather than alarming the user.
 * Only then is a failure consulted, and only `rejected` implies anything about registration:
 *
 * - `rejected` means the service **answered and refused the login**, which is what an unpublished row
 *   produces (`401 {"error":"identity has not been registered"}`).
 * - `unreachable` / `unknown` / `wallet` say nothing about the chain — the attempt never got far
 *   enough to find out. Reporting those as `unregistered` would blame the identity for a dead network
 *   or a cancelled biometric.
 * - `misconfigured` is deliberately *not* `unregistered` either: the identity may well be registered
 *   on the network it belongs to, and this build is simply talking to the wrong service. Telling the
 *   user to re-register would be advice that cannot work.
 */
export const identityRegistrationState = ({
  hasIdentity,
  hasSession,
  cachedRegistered,
  lastFailure,
}: IdentityRegistrationInputs): IdentityRegistrationState => {
  if (!hasIdentity) return 'no-identity'
  if (hasSession) return 'active'
  if (cachedRegistered) return 'registered'
  if (lastFailure === 'rejected') return 'unregistered'
  return 'unknown'
}

/**
 * Whether the UI should offer a retry.
 *
 * `registered` is excluded on purpose: the row is there, so a sign-in button would be offering to fix
 * something that is not broken. `active` needs nothing. `no-identity` is the onboarding/sign-in card's
 * job, not a retry.
 */
export const canRetryRegistration = (state: IdentityRegistrationState): boolean =>
  state === 'unregistered' || state === 'unknown'

/**
 * Whether a surface that **writes to `identity(C)`** should be offered — the name claim and the
 * contact card.
 *
 * Both write the identity contract (`setPrimaryName`, `setRow`), which only exists once the row has
 * been published, so offering them to an unpublished identity is offering an action that cannot
 * complete. `IdScreen` gated them on `identity !== undefined` — an identity *on this device* — which
 * is the very distinction this module exists to draw.
 *
 * Positive evidence only. `unregistered` is a known no; `unknown` means this device has never proved
 * the row exists (no session, no prior success), so there is nothing to write to yet. An identity
 * that *is* published degrades to `registered` rather than `unknown` when offline — that is what the
 * durable cache is for — so this does not hide a real card from someone on a plane.
 */
export const canWriteIdentityRow = (state: IdentityRegistrationState): boolean =>
  state === 'active' || state === 'registered'
