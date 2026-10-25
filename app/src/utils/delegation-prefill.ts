/**
 * Turning a delegation link into a staking-screen prefill.
 *
 * The sibling of `payment-prefill`, and pure for the same reason: the refusals
 * need no running app to test.
 *
 * **Nothing is validated here, because it already has been.** `readLinkAction`
 * only produces a `stake-delegation` once the id has decoded as a `pool1…` over a
 * 28-byte key hash, and a `drep-delegation` only once the id has canonicalised to
 * a `DRepTarget`. Re-checking would be a second answer to one question; the value
 * of this module is that both card surfaces reach the staking screen the same way.
 *
 * A prefill carries one target and leaves the other `null`, which the staking
 * screen reads as "leave it alone" — a pool link says nothing about a DRep and
 * must not disturb one.
 *
 * @module
 */

import type {StakePrefill} from '../screens/cardano/stake/stake-prefill-handoff'
import type {LinkAction} from '../services/link-action'

/**
 * A prefill for the staking screen, or `null` when the action is not a
 * delegation — so a caller can hand it any `LinkAction` and hide the affordance
 * on `null` rather than deciding the kinds itself.
 */
export const delegationPrefillFor = (
  action: LinkAction,
  origin: StakePrefill['origin'] = 'scan',
): StakePrefill | null => {
  if (action.kind === 'stake-delegation') return {poolId: action.poolId, drep: null, origin}
  if (action.kind === 'drep-delegation') return {poolId: null, drep: action.target, origin}
  return null
}
