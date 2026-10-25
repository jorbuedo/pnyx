/**
 * Which input locks a co-funded send has to write, as a pure decision.
 *
 * ⚠️ **One per contributor, not one for the composer.** A co-funded send spends inputs belonging to
 * wallets that are not the selected one and have no live feed listening for them, so nothing changes
 * their cached set until something opens them. Without a lock each of those wallets keeps offering
 * outputs this transaction already spent, and the next build selects one — the node then refuses the
 * whole transaction. That is precisely what `wallet/unshielded-pending-store.ts` was written to
 * prevent, and the co-funded builder arrived later without being wired into it.
 *
 * Its own module because the builder it serves reaches `@pnyx/midnight-native`, which cannot load under
 * vitest — while this decision is the part worth pinning.
 *
 * @module
 */

import type {UnshieldedLock} from '../wallet/unshielded-pending-store'

/** What a built co-funded send says about one wallet's contribution. */
export type LockableContribution = {
  readonly groupId: string
  readonly accountIndex: number
  readonly consumedUtxoIds: readonly string[]
}

export type ContributionLock = {
  readonly groupId: string
  readonly accountIndex: number
  readonly lock: UnshieldedLock
}

/**
 * A lock for every contributor that actually spends something.
 *
 * A contributor with no consumed inputs gets none: an empty lock would be a row that can only expire,
 * and `releaseUnshieldedLocks` treats an identifier-less lock as unreleasable, so writing one would
 * pin nothing while looking like it pinned something.
 */
export const cofundLocks = (
  contributions: readonly LockableContribution[],
  identifiers: readonly string[],
  expiresAt: number,
): readonly ContributionLock[] =>
  contributions
    .filter((contribution) => contribution.consumedUtxoIds.length > 0)
    .map((contribution) => ({
      groupId: contribution.groupId,
      accountIndex: contribution.accountIndex,
      lock: {consumedUtxoIds: contribution.consumedUtxoIds, expiresAt, identifiers},
    }))
