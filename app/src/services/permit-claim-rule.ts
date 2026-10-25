/**
 * Which wallet can actually claim a name, given where the permits are.
 *
 * A permit is an ordinary token, so it sits in **one** wallet — and `bind` spends it from the wallet
 * the claim runs against, which is whichever one is selected (`useHandleActions`). So holding a permit
 * is not the same as being able to use it, and the difference is a wallet switch the user has to make.
 *
 * Balances are shown across every wallet on purpose: a permit bought into a wallet you are not looking
 * at is still yours, and a screen that showed only the selected wallet would report it missing. What
 * this rule adds is the other half — naming the wallet to switch to, rather than leaving a claim that
 * silently cannot proceed.
 *
 * Pure, and its own module so it can be tested without a store or a chain — the same split
 * `handle-offer-rule.ts` uses for the pricing half.
 *
 * @module
 */

import type {HandleOffer} from './handle-offer-rule'
import type {PermitWallet, WalletPermits} from './permit-balances'

export type PermitClaimDecision =
  /** Nothing to decide: the tier is free, so no permit is involved at all. */
  | {readonly kind: 'free'}
  /** The selected wallet holds a permit for this tier. */
  | {readonly kind: 'ready'}
  /**
   * Another wallet holds one. `wallet` is which.
   *
   * ⚠️ Not an error state, and **not yet a claim**: `bind` funds only from the name's own permit
   * address, so a wallet-held ticket must be transferred there first — the delivery step that waits on
   * the native port. This says where the ticket is; the copy must not imply switching is sufficient.
   */
  | {readonly kind: 'switch-wallet'; readonly wallet: PermitWallet}
  /** No wallet on this device holds a permit for the tier. */
  | {readonly kind: 'no-permit'}
  /**
   * At least one wallet has never synced, so "no permit" cannot be asserted.
   *
   * Kept apart from {@link no-permit} deliberately: telling someone they hold nothing because a cache
   * was empty is the same lie as reporting a failed read as an empty wallet.
   */
  | {readonly kind: 'unknown'}
  /** The tier is not obtainable on this build at all — closed, or priced in a currency it cannot read. */
  | {readonly kind: 'unavailable'}

/**
 * What the claim button should do for `offer`, given who holds what.
 *
 * @param selected the wallet a claim would currently run against, or `undefined` when none is selected
 */
export const permitClaimDecision = (params: {
  readonly offer: HandleOffer
  readonly wallets: readonly WalletPermits[]
  readonly selected: {readonly groupId: string; readonly accountIndex: number} | undefined
}): PermitClaimDecision => {
  const {offer, wallets, selected} = params

  // `free` and `yours` need no permit: the first mints its own, the second is already bound and only
  // needs the row write that displays it.
  if (offer.kind === 'free' || offer.kind === 'yours') return {kind: 'free'}
  // `priced` is the only shape that needs a permit — everything else is closed, taken, reserved,
  // invalid or unreadable, none of which a permit would unblock.
  if (offer.kind !== 'priced') return {kind: 'unavailable'}

  const tier = offer.tier
  const holds = (entry: WalletPermits): boolean => (entry.byTier?.get(tier) ?? 0n) > 0n

  const selectedEntry =
    selected === undefined
      ? undefined
      : wallets.find(
          (entry) => entry.wallet.groupId === selected.groupId && entry.wallet.accountIndex === selected.accountIndex,
        )
  if (selectedEntry !== undefined && holds(selectedEntry)) return {kind: 'ready'}

  const elsewhere = wallets.find((entry) => entry !== selectedEntry && holds(entry))
  if (elsewhere !== undefined) return {kind: 'switch-wallet', wallet: elsewhere.wallet}

  // Only now does "nobody holds one" get asserted — and only if every wallet was actually readable.
  return wallets.some((entry) => entry.byTier === undefined) ? {kind: 'unknown'} : {kind: 'no-permit'}
}
