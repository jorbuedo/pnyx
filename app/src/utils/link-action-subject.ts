/**
 * Turning a classified link into what the sheet is about.
 *
 * `readLinkAction` says what a link *is*; this says what the sheet would show for
 * it. Every kind maps — the ones with no wallet question of their own become
 * `other`, which the sheet renders as the card behind a confirmation.
 *
 * **`null` means "there is nothing to open"**, and exactly one thing produces it:
 * a payment with no address to pay. The multisig pair used to as well, on the
 * grounds that they have their own flow and their own consent — true of the flow,
 * but it left an invite arriving from outside a DM with no landing at all, so
 * `handleQrAction` dropped it silently on the way to home. They land as `other`
 * now; the sheet still refuses to invent a reply channel for an invite, and offers
 * a co-signer key the one destination that needs no thread.
 *
 * Mapping every kind is what lets a link arriving from *outside* the app land on a
 * screen instead of acting. Whether a caller uses that is the caller's decision —
 * a card already in the user's own thread does not need a confirmation to open a
 * page, and passes `other` over. Pure, so the mapping is testable without a
 * running app.
 *
 * It exists because two surfaces render these cards — DM threads and circle
 * channels — and a card tapped in one must open exactly what it opens in the
 * other. Building the subject inline at each call site is how those two drift.
 *
 * @module
 */

import type {LinkActionSubject} from '../screens/cardano/LinkActionSheet'
import type {StakePrefill} from '../screens/cardano/stake/stake-prefill-handoff'
import type {LinkAction} from '../services/link-action'
import {delegationPrefillFor} from './delegation-prefill'
import {paymentPrefillFor} from './payment-prefill'

/**
 * What tapping this card should open, or `null` when it opens no sheet.
 *
 * A payment with no address to pay is the one case that classifies but cannot be
 * acted on, and `paymentPrefillFor` is what decides that — kept there rather than
 * duplicated here.
 */
export const linkActionSubjectFor = (
  action: LinkAction,
  origin: StakePrefill['origin'] = 'scan',
): LinkActionSubject | null => {
  if (action.kind === 'payment-request') {
    const prefill = paymentPrefillFor(action.address, action.lovelace, origin)
    return prefill === null
      ? null
      : {
          kind: 'payment',
          prefill,
          note: action.message,
          paymentId: action.paymentId,
          asksForAssets: action.asksForAssets,
        }
  }

  if (action.kind === 'address') {
    // An open request: the sheet asks which wallet and the funnel asks how much.
    const prefill = paymentPrefillFor(action.address, null, origin)
    return prefill === null ? null : {kind: 'payment', prefill}
  }

  // Switched on `kind` rather than on a non-null prefill: only the discriminant
  // narrows the action, and the fields below are read off that narrowing.
  if (action.kind === 'stake-delegation') {
    const prefill = delegationPrefillFor(action, origin)
    return prefill === null ? null : {kind: 'delegation', prefill, poolId: action.poolId}
  }
  if (action.kind === 'drep-delegation') {
    const prefill = delegationPrefillFor(action, origin)
    return prefill === null ? null : {kind: 'delegation', prefill, drepId: action.drepId, drepTarget: action.target}
  }
  // Everything else: a dApp, something to look at, a multisig hand-off, or a kind
  // this build can name and not carry out. The card describes each of them already,
  // and the sheet puts that card behind a confirmation.
  return {kind: 'other', action}
}
