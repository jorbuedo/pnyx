/**
 * In-memory handoff from a delegation link to the staking screen.
 *
 * Same mechanism and the same reasons as `send-prefill-handoff`: a delegation
 * target arrives from outside the app — a card tapped in a DM or a circle, a
 * scanned QR — and the staking screen has to open with it already chosen. A
 * `DRepTarget` is a tagged union rather than a string, so it does not survive a
 * route param at all; going through one registry also keeps a single answer to
 * "where did this come from", which matters because the answer is *untrusted
 * input*.
 *
 * **A prefill is a suggestion, never an instruction.** It fills what the user
 * would otherwise have picked in the two picker sheets, and stops there: the
 * screen's own confirm, the review screen and the signing ceremony all still
 * happen. Nothing here delegates anything.
 *
 * Both fields are nullable and mean exactly what the same fields mean in
 * `DelegationSelection` — `null` is "leave this target alone", not "clear it".
 * A `web+cardano://stake` link carries a pool and says nothing about a DRep, and
 * the reverse for `//drep`; neither should disturb the other.
 *
 * Single-consumer and evicted on claim, so a re-mount cannot silently re-apply a
 * target the user already changed or abandoned.
 *
 * @module
 */

import type {DRepTarget} from '../../../services/cardano-pool-drep/drep-id'

export type StakePrefill = {
  /** `pool1…` bech32, already decoded as one by the classifier. */
  readonly poolId: string | null
  /**
   * The canonical target, never a display name. A link may say *which* DRep; it
   * does not get to say what that DRep is called.
   */
  readonly drep: DRepTarget | null
  /** Where it came from, for what the screen says. */
  readonly origin: 'link' | 'scan'
}

const prefills = new Map<string, StakePrefill>()
let counter = 0

/** Register a prefill; returns the id to pass as the `prefill` route param. */
export const registerStakePrefill = (prefill: StakePrefill): string => {
  counter += 1
  const id = `stk_${counter}`
  prefills.set(id, prefill)
  return id
}

/** Take the prefill, removing it. */
export const claimStakePrefill = (id: string): StakePrefill | undefined => {
  const prefill = prefills.get(id)
  prefills.delete(id)
  return prefill
}
