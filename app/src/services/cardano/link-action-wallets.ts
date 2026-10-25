/**
 * Which wallet a link action can be carried out with, and what that will involve.
 *
 * **A link must not act on whatever wallet happens to be selected.** The selected
 * wallet is a leftover from whatever the user was doing before, and a payment
 * request arriving in a message has no opinion about it. Choosing is the user's
 * decision, so the link's sheet asks — and this is the rule for what it may offer.
 *
 * The only wallet left out is one that can **never** produce a witness. A shared
 * wallet is offered like any other: this app builds a script spend, signs our share
 * and hands it to the co-sign rail, which is a real way to pay a request. Hiding it
 * would be deciding for the user that gathering signatures is not worth it. What the
 * sheet owes them instead is the *consequence* — the payment does not complete when
 * they confirm, it goes to the co-signers — so the capability is named rather than
 * used as a filter.
 *
 * @module
 */

import type {WalletSource} from '@pnyx/wallet'

/** What paying from this wallet will actually involve. */
export type SpendCapability =
  /** Its own signature is enough; confirming completes the payment. */
  | 'signs-alone'
  /**
   * A shared wallet. It signs our share and the transaction then waits on the other
   * co-signers, so confirming starts a gather rather than finishing a payment. The
   * distinction has to reach the user, which is why this is a capability and not an
   * exclusion.
   */
  | 'needs-co-signers'
  /** Holds a watch-only xpub — it can see funds and never move them. */
  | 'cannot-sign'

/**
 * Keyed on the wallet's *source*, the same input `signerKindOf` and
 * `coSignerKeySourceOf` use, so the three cannot drift into disagreeing about what
 * a wallet is.
 *
 * `undefined` is a group whose primary chain wallet has not loaded yet. Treated as
 * signing rather than hidden: the list would silently be shorter than the user's own
 * wallet list, and the funnel does the real signer check anyway.
 */
export const spendCapability = (source: WalletSource | undefined): SpendCapability => {
  if (source === 'read-only') return 'cannot-sign'
  if (source === 'multisig') return 'needs-co-signers'
  // mnemonic, hardware and imported-xpriv all hold something that signs. Hardware
  // needs the device present, which the ceremony asks for when it gets there — that
  // is a prompt, not an impossibility.
  return 'signs-alone'
}

/** True when this wallet can be offered for a link's spend at all. */
export const canSpendForLink = (source: WalletSource | undefined): boolean => spendCapability(source) !== 'cannot-sign'
