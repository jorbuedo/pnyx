/**
 * The hold itself: a map, its lifetime, and nothing that can derive a key.
 *
 * Split from `./sync-keys.ts` so the lock lifecycle can evict without importing wallet derivation.
 * `useCeremonyCacheLifecycle` only needs to *drop* keys, and pulling `@pnyx/wallet` into a React hook
 * to do that widened its module graph as far as `react-native` — a cost paid by every consumer, for a
 * function that clears a `Map`.
 *
 * The residency rules live here because this is the file that can enforce them. Why they are what they
 * are, and why this material is never persisted, is in `./sync-keys.ts`.
 *
 * @module
 */

import {logger} from '../../logger'

const ORIGIN = 'midnight-sync-keys'

export type MidnightSyncKeys = {
  /** Role-2 (Dust) key — reads generation entries into a DUST state. */
  readonly dust: Uint8Array
  /**
   * The wallet's `mn_dust…` address, and the network it belongs to.
   *
   * Carried here because it is derived from the same seed in the same breath, and a scheduled sync
   * would otherwise need the vault to work out *what* to read — which would defeat the point.
   */
  readonly dustAddress: string
  readonly network: string
}

/**
 * One held entry, carrying the identity it was filed under.
 *
 * ⚠️ **The identity is a field, not something to parse back out of the cache key.** It used to be
 * recovered with `lastIndexOf(':')` on a `groupId:accountIndex` key, which silently produced a `NaN`
 * account the moment the key gained a third component — exactly the change below.
 */
export type HeldSyncKeys = {
  readonly groupId: string
  readonly accountIndex: number
  readonly keys: MidnightSyncKeys
}

/**
 * ⚠️ **The network is part of the key, not just of the value.**
 *
 * A wallet has a DUST key on *every* network — the role key is the same bytes (it derives from the
 * seed with no network in the path) and only the `mn_dust…` address differs. Keying on
 * `groupId:accountIndex` alone therefore held one network's entry at a time, and since the book is
 * written from this cache, deriving a key on one network **evicted and then overwrote** the other
 * network's stored entry. Switching networks stranded the wallet it left behind: the scheduler
 * correctly refused a foreign-network key and nothing re-derived one, so DUST read as absent until a
 * user-initiated refresh, indistinguishable from a wallet that has none.
 */
const cacheKeyOf = (groupId: string, accountIndex: number, network: string): string =>
  `${groupId}:${accountIndex}:${network}`

const cache = new Map<string, HeldSyncKeys>()

/** Hold a derived set until lock. Called only by `./sync-keys.ts`, which is what derives them. */
export const putSyncKeys = (groupId: string, accountIndex: number, keys: MidnightSyncKeys): void => {
  cache.set(cacheKeyOf(groupId, accountIndex, keys.network), {groupId, accountIndex, keys})
  logger.debug('remembered the midnight sync keys until lock', {
    origin: ORIGIN,
    groupId,
    accountIndex,
    network: keys.network,
  })
}

/**
 * The remembered keys, or `undefined` when none are held.
 *
 * `undefined` means "ask the user", never "sync without a key" — a caller that treats it as the second
 * would produce an empty state and report it as a balance.
 */
export const getSyncKeys = (groupId: string, accountIndex: number, network: string): MidnightSyncKeys | undefined =>
  cache.get(cacheKeyOf(groupId, accountIndex, network))?.keys

/** Whether a background sync can run for this wallet on this network without prompting. */
export const canSyncWithoutPrompt = (groupId: string, accountIndex: number, network: string): boolean =>
  cache.has(cacheKeyOf(groupId, accountIndex, network))

/**
 * Which networks this account has a held key for, in a stable order.
 *
 * Lets a caller tell "this wallet has no key at all" from "this wallet has keys, but not for the
 * network you are on" — two states that used to be one `undefined`, and only the second is a
 * condition a refresh can clear.
 */
export const heldNetworksFor = (groupId: string, accountIndex: number): readonly string[] =>
  [...cache.values()]
    .filter((held) => held.groupId === groupId && held.accountIndex === accountIndex)
    .map((held) => held.keys.network)
    .sort()

/**
 * Drop one account's keys on **every** network — the account was disabled, so none of them describe
 * anything the scheduler should read.
 */
export const forgetSyncKeys = (groupId: string, accountIndex: number): void => {
  for (const [key, held] of [...cache.entries()]) {
    if (held.groupId === groupId && held.accountIndex === accountIndex) cache.delete(key)
  }
}

/**
 * Drop every held key. Called on lock, beside the ceremony and identity caches.
 *
 * Locking is the explicit user signal that residency ends; backgrounding is not, and evicting there
 * would re-prompt all day for a phone doing what phones do.
 */
export const forgetAllSyncKeys = (): void => {
  if (cache.size > 0) {
    logger.debug('dropped the midnight sync keys on lock', {origin: ORIGIN, wallets: cache.size})
  }
  cache.clear()
  restored = false
}

/**
 * Whether the persisted key book has been read this session.
 *
 * ⚠️ **This is what an append is allowed to trust, and `cache.size === 0` is not.** An empty cache is
 * two different facts: "the book was read and holds nothing" and "the book was never read" — and only
 * the first makes it safe to write the cache back as the whole book. Writing on the second would
 * replace every other wallet's key with nothing. The read can genuinely fail (an unreachable keystore,
 * a cancelled prompt) and then a wallet creation would follow it, so the distinction is not
 * theoretical.
 */
let restored = false

/** Record that the book was read — or confirmed absent, which is equally a known state. */
export const markSyncKeyBookRestored = (): void => {
  restored = true
}

export const isSyncKeyBookRestored = (): boolean => restored

/**
 * Drop every account's keys for one group — the wallet is gone, so they describe nothing.
 *
 * Returns how many were dropped, so a caller can skip persisting when nothing changed.
 */
export const forgetSyncKeysForGroup = (groupId: string): number => {
  let dropped = 0
  for (const [key, held] of [...cache.entries()]) {
    if (held.groupId === groupId) {
      cache.delete(key)
      dropped += 1
    }
  }
  if (dropped > 0) {
    logger.debug('dropped a deleted group midnight sync keys', {origin: ORIGIN, groupId, accounts: dropped})
  }
  return dropped
}

/** Every held entry, for writing the book back — each carrying the identity it is filed under. */
export const allSyncKeys = (): readonly HeldSyncKeys[] => [...cache.values()]
