/**
 * How many claim permits each of this device's wallets holds, per tier.
 *
 * A permit is an ordinary unshielded token whose colour is
 * `customUnshieldedTokenType(paymentContract, permitDomain(tier))` — plain SHA-256, derived here
 * rather than bridged (see `@pnyx/contract-client/derivations`). So "do I hold a t4 permit" is a
 * lookup in a wallet's own token totals, not a chain read.
 *
 * ⚠️ **Exact tier, never tier-or-better.** `bind` accepts only the name's own tier, so a t0 permit
 * buys nothing for a t3 name and must never be counted toward one.
 *
 * **Reads the cache, deliberately.** {@link readSpendableUnshielded} is the "what a balance should
 * show" half — the cached set with in-flight locks applied — so opening this screen costs no network
 * round trip per wallet. Freshness is the background scheduler's job, which covers every wallet group
 * rather than only the selected one. A wallet that has never synced reports `unsynced` rather than
 * zero: "no permits" and "we have not looked" are different facts, and rendering the second as the
 * first is how a user concludes they own nothing.
 *
 * @module
 */

import {permitTokenType} from '@pnyx/contract-client/derivations'
import {hex} from '@pnyx/crypto'
import {Effect} from 'effect'
import {logger} from '../logger'
import {readSpendableUnshielded} from './midnight/wallet/unshielded'
import {totalsByToken} from './midnight/wallet/unshielded-utxo-set'

const ORIGIN = 'permit-balances'

/** Every tier the namespace defines. Fixed by the contract, not by what is currently sold. */
export const TIERS = [0, 1, 2, 3, 4, 5, 6] as const

/** One wallet this device can look in. The caller supplies these; enumerating them is the UI's job. */
export type PermitWallet = {
  readonly groupId: string
  readonly accountIndex: number
  /** What to call it on screen. */
  readonly label: string
}

export type WalletPermits = {
  readonly wallet: PermitWallet
  /**
   * Permits held, by tier. Absent tiers are zero.
   *
   * `undefined` when this wallet has never been synced — not an empty map, because the screen has to
   * say "not synced" rather than "none".
   */
  readonly byTier: ReadonlyMap<number, bigint> | undefined
}

export type PermitBalances = {
  readonly wallets: readonly WalletPermits[]
  /** Summed across every *synced* wallet. */
  readonly totalByTier: ReadonlyMap<number, bigint>
  /** True when at least one wallet could not be read, so the totals are a floor rather than a count. */
  readonly incomplete: boolean
}

/** The seven permit colours for a payment contract, as lowercase hex. Pure; cheap enough to recompute. */
export const permitColours = (paymentAddress: Uint8Array): ReadonlyMap<string, number> => {
  const byColour = new Map<string, number>()
  for (const tier of TIERS) byColour.set(hex.encode(permitTokenType(paymentAddress, tier)), tier)
  return byColour
}

/**
 * Which of a wallet's token totals are permits, keyed by tier.
 *
 * Pure, and separate from the Effect above so it can be tested without a store: this is where a
 * colour mismatch or a sign error would hide.
 */
export const tallyPermits = (
  totals: ReadonlyMap<string, bigint>,
  byColour: ReadonlyMap<string, number>,
): ReadonlyMap<number, bigint> => {
  const mine = new Map<number, bigint>()
  for (const [token, amount] of totals) {
    const tier = byColour.get(token.toLowerCase())
    // A zero or negative total is not a holding. Tokens the wallet holds that are not permits are
    // simply absent from `byColour`, which is the whole filter.
    if (tier === undefined || amount <= 0n) continue
    mine.set(tier, (mine.get(tier) ?? 0n) + amount)
  }
  return mine
}

/**
 * Permits held across the given wallets.
 *
 * Never fails: a wallet whose cache cannot be read is reported as unsynced and logged, because one
 * unreadable wallet must not blank the others.
 */
export const readPermitBalances = (
  wallets: readonly PermitWallet[],
  paymentAddress: Uint8Array,
): Effect.Effect<PermitBalances> =>
  Effect.gen(function* () {
    const byColour = permitColours(paymentAddress)
    const results: WalletPermits[] = []
    const totalByTier = new Map<number, bigint>()
    let incomplete = false

    for (const wallet of wallets) {
      const cache = yield* readSpendableUnshielded({
        groupId: wallet.groupId,
        accountIndex: wallet.accountIndex,
      }).pipe(
        Effect.catchAll((error) => {
          logger.warn('a wallet’s unshielded cache could not be read, so its permits are unknown', {
            origin: ORIGIN,
            groupId: wallet.groupId,
            accountIndex: wallet.accountIndex,
            error: String(error),
          })
          return Effect.succeed(undefined)
        }),
      )

      if (cache === undefined) {
        logger.debug('a wallet has no unshielded cache yet, so its permits are unknown', {
          origin: ORIGIN,
          groupId: wallet.groupId,
          accountIndex: wallet.accountIndex,
        })
        incomplete = true
        results.push({wallet, byTier: undefined})
        continue
      }

      const mine = tallyPermits(totalsByToken(cache.utxos), byColour)
      for (const [tier, amount] of mine) totalByTier.set(tier, (totalByTier.get(tier) ?? 0n) + amount)
      results.push({wallet, byTier: mine})
    }

    return {wallets: results, totalByTier, incomplete}
  })
