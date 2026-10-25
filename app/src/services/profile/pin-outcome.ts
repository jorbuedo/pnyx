/**
 * What a typed code does — pure.
 *
 * Resolving a code is a lookup against the stored verifiers, never a
 * comparison against a plaintext PIN: the config holds Argon2id verifiers only
 * (see `pin-config.ts`). This module is handed the already-verified match and
 * decides the consequence, so the decision table is testable without a KDF.
 *
 * @module
 */

import {DECOY_PROFILE_ID, DEFAULT_PROFILE_ID, type ProfileId} from './profile-id'

/** Which configured code a typed PIN matched. */
export type CodeKind = 'real' | 'decoy' | 'wipe'

/** What the app does about it. */
export type PinOutcome = {
  /** The namespace to open. */
  readonly profileId: ProfileId
  /** Whether to destroy the real profile in the background after opening. */
  readonly wipe: boolean
}

/**
 * Consequence of a matched code.
 *
 * The wipe code opens the **decoy**, identical to the decoy code — it must not
 * be visually distinguishable, because the point is that a coercer watching the
 * unlock sees an ordinary session while the real profile is being destroyed.
 */
export const outcomeForCode = (kind: CodeKind): PinOutcome => {
  switch (kind) {
    case 'real':
      return {profileId: DEFAULT_PROFILE_ID, wipe: false}
    case 'decoy':
      return {profileId: DECOY_PROFILE_ID, wipe: false}
    case 'wipe':
      return {profileId: DECOY_PROFILE_ID, wipe: true}
  }
}

/**
 * Whether a proposed set of codes is safe to store.
 *
 * One rule: no two codes may be equal. A duplicate would make one of them
 * unreachable, and which one won would depend on match order.
 *
 * Every code is the **same length**, deliberately. An earlier draft forced the
 * wipe code to a different length so no single mistyped digit could reach an
 * irreversible action — but the digit count is visible to anyone watching you
 * type, and that observer is precisely the threat this feature exists for. A
 * code of an unusual length announces itself as something other than the normal
 * PIN. The residual typo risk is accepted, and mitigated by the confirm-twice
 * setup flow rather than by leaking a distinguishing signal.
 */
export const validateCodeSet = (codes: {
  readonly real: string
  readonly decoy?: string | undefined
  readonly wipe?: string | undefined
}): {readonly ok: true} | {readonly ok: false; readonly reason: 'duplicate'} => {
  const present = [codes.real, codes.decoy, codes.wipe].filter((c): c is string => c !== undefined && c !== '')
  if (new Set(present).size !== present.length) return {ok: false, reason: 'duplicate'}
  return {ok: true}
}
