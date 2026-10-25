/**
 * What the send flow may do with each asset the wallet holds.
 *
 * A CIP-113 token cannot be moved by an ordinary transaction. Its UTxOs sit at the deployment's
 * script credential, so spending one runs the whole protocol — script, withdraw-zero, registry
 * reference inputs, the issuer's transfer logic. It also cannot share a basket with ordinary
 * assets: different inputs, a different builder and its own review, so there is nothing for the
 * multi-asset allocate step to allocate.
 *
 * ⚠️ **Keeping it out of the basket is right; keeping it out of the picker was not.** A first cut
 * simply withheld these ids, which made a token the user can see in their portfolio silently
 * unpickable, with no path and no reason — the dead affordance this repo has a rule against. The
 * picker is precisely where the branch belongs, because it is where the user asks the question.
 *
 * So every held asset is offered, and each carries what selecting it does.
 *
 * @module
 */

import type {SendEligibility} from '../../../services/cardano/cip113/send-eligibility'

export type AssetDisposition =
  /** An ordinary native asset: add it to the basket, as always. */
  | {readonly kind: 'ordinary'}
  /**
   * A programmable token this wallet can move. Selecting it leaves the basket flow for the
   * protocol path — it replaces the send rather than joining it.
   */
  | {readonly kind: 'programmable'; readonly transferLogicHashHex: string; readonly warnsSeizure: boolean}
  /**
   * A programmable token that cannot be moved from here, with the reason. Offered and disabled
   * rather than hidden: "why is my token missing" is a worse question than a sentence explaining
   * that its issuer gates transfers.
   */
  | {readonly kind: 'blocked'; readonly detail: string}

/**
 * What selecting this asset should do.
 *
 * `eligibilityOf` returns `undefined` for an asset that is not programmable at all, which is the
 * common case and the cheap path — no registry lookup for an ordinary token.
 */
export const dispositionOf = (
  assetId: string,
  eligibilityOf: (assetId: string) => SendEligibility | undefined,
): AssetDisposition => {
  const eligibility = eligibilityOf(assetId)
  if (eligibility === undefined) return {kind: 'ordinary'}
  switch (eligibility.kind) {
    case 'sendable':
      return {
        kind: 'programmable',
        transferLogicHashHex: eligibility.transferLogicHashHex,
        // `unknown` warns as loudly as `possible`; only `disabled` is clean.
        warnsSeizure: eligibility.seizure.kind !== 'disabled',
      }
    case 'needs-issuer':
      return {kind: 'blocked', detail: eligibility.detail}
    case 'unclassifiable':
      return {kind: 'blocked', detail: eligibility.detail}
    // Not a token of this deployment after all — the registry disagrees with the holdings read.
    // Treated as ordinary rather than blocked: refusing to send a plain native asset because a
    // registry lookup came back empty would be the worse failure.
    case 'unregistered':
      return {kind: 'ordinary'}
  }
}

/**
 * Whether an asset may enter the multi-asset basket.
 *
 * The invariant the ordinary build depends on, kept as its own function so it can be asserted
 * directly: only `ordinary` assets are ever allocated across recipients.
 */
export const mayEnterBasket = (disposition: AssetDisposition): boolean => disposition.kind === 'ordinary'
