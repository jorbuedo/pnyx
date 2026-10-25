/**
 * Process-local cache for the Midnight **sync** role keys, with a lifetime.
 *
 * Reading a DUST generation entry needs a role key, so the sync opens the vault. That made it
 * user-initiated by necessity: a timer that fired a fingerprint prompt because a background fiber woke
 * up is not a refresh. The consequence was worse than the inconvenience — a DUST state went stale
 * fifteen minutes after somebody pressed a button and self-funded sends switched themselves off with
 * no way back.
 *
 * ⚠️ **DUST only.** This used to cache the Zswap role key too, for a shielded sync that never read it:
 * the spend paths derive their own from the seed (`build-transfer.ts`), and nothing consumed the cached
 * copy. So it was holding coin-spending capability with no consumer — removed 2026-08-24. The shielded
 * sync stays prompt-driven, which is a deliberate scope choice and not an oversight.
 *
 * This is the same narrowing `identity-role-keys.ts` made for the Cardano identity keys: one named
 * hold of **derived keys**, evicted on lock, instead of a prompt per sync. Deliberately modelled on
 * it, including the lifetime, so there is one story about residency in this app rather than two.
 *
 * ### What it holds, and the part that is not bounded
 *
 * Never the mnemonic, and never anything the sync does not use — that much matches the identity
 * cache. But that module can truthfully say its keys "cannot sign for a funds wallet", and **this one
 * cannot**: a DUST role key signs a dust spend. That is fee money rather than a wallet's balance, which
 * is why the blast radius is narrower since the Zswap key left — but it is still not *nil*, so the
 * bound is *residency and reach*, not capability:
 *
 * - **Residency** — memory only, never persisted, evicted on lock (survives background, which is
 *   constant on mobile and not a security event).
 * - **Reach** — nothing outside the sync modules may import this. That is enforced by
 *   `sync-keys-scope.test.ts`, not by this comment, because a comment is not a gate.
 *
 * ⚠️ **The shielded half cannot be narrowed to viewing-only, and an earlier version of this note said
 * it could.** `midnight-zswap`'s `SecretKeys` does split `coin_secret_key` (spending) from
 * `encryption_secret_key` (decrypting ciphertexts), and `try_decrypt` genuinely uses only the second —
 * but decryption is one step of a sync, not the sync. `State::insert_coin`, which is how a discovered
 * coin enters the wallet, derives the coin's **nullifier** from `coin_secret_key`
 * (`SenderEvidence::User`) and its commitment from `coin_public_key()`, and the state is *indexed by
 * that nullifier*. So the shielded wallet's index is spend-derived by construction: no native op
 * exposing the encryption key alone would be enough, and there is no viewing-only shielded sync to be
 * had from this ledger API. Checked against `midnight-zswap` 8.1.0 `local.rs:86` on 2026-08-24.
 *
 * That matters for any proposal to keep these keys somewhere more available than memory: for the
 * shielded rail it is coin-spending capability, not a viewing key, and no amount of narrowing changes
 * that today.
 *
 * @module
 */

import {Roles} from '@midnight-ntwrk/wallet-sdk-hd'
import {deriveMidnightReceiveAddresses, deriveMidnightRoleKey} from '@pnyx/wallet'
import {mnemonicToSeedSync} from '@scure/bip39'
import {Effect} from 'effect'

import {logger} from '../../logger'
import {appendDustKeysToBook} from './dust-key-book'
import {knownMidnightNetworks} from './networks'
import type {MidnightSyncKeys} from './sync-keys-store'

export {
  canSyncWithoutPrompt,
  forgetAllSyncKeys,
  forgetSyncKeys,
  getSyncKeys,
  heldNetworksFor,
  type MidnightSyncKeys,
} from './sync-keys-store'

/**
 * Derive both sync keys from a mnemonic the caller has already been authorised to hold, and remember
 * them until lock.
 *
 * Takes the mnemonic rather than fetching it, so this module never opens the vault itself: the prompt
 * belongs to whatever the user actually asked for, and this only avoids asking twice.
 */
export const rememberSyncKeys = async (
  groupId: string,
  accountIndex: number,
  mnemonic: string,
  network: string,
): Promise<MidnightSyncKeys> => {
  const seed = mnemonicToSeedSync(mnemonic)
  // ⚠️ **Every network this build knows, from the one prompt** — and the caller's own even if this
  // build has no endpoints for it, since a key is still the right thing to hold for a network the
  // user is demonstrably on.
  //
  // The DUST role key has **no network in its derivation path** (`m/44'/2400'/account'/role/index`),
  // so all of these share one key and differ only in the `mn_dust…` address's HRP. That is what makes
  // this nearly free: one role-key derivation and one cheap address encoding per network, against a
  // prompt the user has already answered. Deriving only the active network is what stranded a wallet
  // on every switch — the other network's key could then only come from another prompt, and a
  // scheduled tick is deliberately not allowed to raise one.
  const networks = [...new Set([network, ...knownMidnightNetworks()])]
  const dust = await Effect.runPromise(deriveMidnightRoleKey(seed, Roles.Dust, {account: accountIndex}))
  const derived = await Promise.all(
    networks.map(async (one): Promise<MidnightSyncKeys> => {
      const addresses = await Effect.runPromise(deriveMidnightReceiveAddresses(seed, {networkId: one}))
      return {dust, dustAddress: addresses.dust, network: one}
    }),
  )
  // ⚠️ **This is also how a missing entry heals.** The book can be incomplete — a wallet created before
  // it existed, or an append that refused because the book was not readable at the time — and every
  // caller of this function is holding the mnemonic for a prompt the user just answered. So a manual
  // refresh, a send, a registration or the DUST probe each repair that wallet's entry in passing,
  // rather than needing a migration or leaving one wallet permanently prompt-driven.
  await Effect.runPromise(appendDustKeysToBook(groupId, accountIndex, derived))
  const own = derived.find((one) => one.network === network)
  // `networks` is seeded with `network`, so this cannot miss; the throw states the invariant rather
  // than inventing an entry for a network we did not derive.
  if (own === undefined) throw new Error(`no dust key was derived for ${network}`)
  return own
}

const ORIGIN = 'midnight-sync-keys'

/**
 * Remember the sync keys off the back of a prompt the user has **already** answered.
 *
 * ## Why a money path does this at all
 *
 * The scheduled DUST sync needs the Dust role key, which comes from the seed — so it cannot derive one
 * without a biometric prompt, and it declines every tick with "no sync keys are held". Meanwhile *any*
 * unshielded movement makes the DUST state `activity`-stale, so `decideFeePayer` sends the fee to the
 * sponsor. The result was that self-funding worked until a wallet's first movement and then never again
 * until the user refreshed DUST by hand.
 *
 * A send has just been through the vault. Leaving the keys behind costs no prompt and lets the tick that
 * follows do the sync — and the tick is the *right* place for it, because `saveDustState` records the
 * cached unshielded watermark: syncing immediately after submitting would store the pre-send cursor and
 * be stale again at once. The tick reads that watermark whenever it runs, after the feed has moved.
 *
 * ⚠️ **Never allowed to fail its caller.** This is bookkeeping on a money path; an approved send must
 * not be lost because a key the *scheduler* wanted could not be derived. Logged instead — and not
 * silently, because a send that quietly left no keys is a wallet that quietly stops keeping DUST
 * current, which is the whole defect this exists to close.
 */
export const rememberSyncKeysForScheduler = async (
  groupId: string,
  accountIndex: number,
  mnemonic: string,
  network: string,
): Promise<void> => {
  try {
    await rememberSyncKeys(groupId, accountIndex, mnemonic, network)
  } catch (error) {
    logger.warn('could not remember the sync keys after a send, so dust will stay stale until a refresh', {
      origin: ORIGIN,
      groupId,
      error: String(error),
    })
  }
}
