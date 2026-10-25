// Witness implementations for `contract/payment.compact`.
//
// Two witnesses, both secrets. `grantSecret` is the preimage of `adminAuth`, and knowing it authorises
// every gated circuit; `nextAdminSecret` is the preimage `rotateAdmin` installs in its place. There is
// no in-circuit signature check anywhere on Midnight, and Compact 0.23 does not expose the ledger's
// authenticated caller, so authorisation is hash-preimage or nothing — which is also what
// OpenZeppelin's `Ownable` does.
//
// **`adminAuth` is mutable, so a leak is recoverable.** `rotateAdmin` is the whole reason it is not
// sealed: a sealed field is part of the address, and this contract can never be redeployed, so a leaked
// secret would have been permanent for the life of the namespace. ⚠️ Rotation bounds the *window*, not
// the damage — permits minted before we notice stay minted, and names claimed cheap stay claimed.
//
// A caller who is not the admin still has to supply *something* for both, because witnesses are
// declared for every circuit; any 32 bytes will do and the assert will refuse them.
import type {Witnesses} from '../../../contract/managed/payment/contract/index.js'

export type PaymentPrivateState = {
  /** Preimage of the current `adminAuth`. Every gated circuit reads it. */
  readonly grantSecret: Uint8Array
  /**
   * Preimage of the `adminAuth` that `rotateAdmin` will install. Only `rotateAdmin` reads it.
   *
   * A witness rather than a circuit parameter so a rotation never puts the incoming secret in a
   * transaction — only its commitment reaches the chain.
   */
  readonly nextAdminSecret: Uint8Array
}

export const createPaymentWitnesses = (): Witnesses<PaymentPrivateState> => ({
  grantSecret: ({privateState}) => [privateState, privateState.grantSecret],
  nextAdminSecret: ({privateState}) => [privateState, privateState.nextAdminSecret],
})
