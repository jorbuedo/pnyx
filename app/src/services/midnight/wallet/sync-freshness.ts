/**
 * Which wallets are due a background refresh — so none of them goes stale unnoticed.
 *
 * ⚠️ **Only the active wallet is kept permanently current.** That is deliberate and stays that way: a
 * permanent sync per wallet means a socket and a fold per wallet, and the DUST side of it is a native
 * rebuild. What was missing is the other half — a wallet you are *not* looking at was refreshed by
 * nothing at all, so its balance could be arbitrarily old and nothing said so.
 *
 * That is not hypothetical. Measured 2026-08-29: a wallet granted to an agent reported 60 NIGHT for
 * twelve hours after spending it, because the only thing that ever synced it was a co-funded build
 * that happened to name it as a contributor (`applied: 2`, twelve hours late). s84 recorded this as a
 * "7-minute lag"; it was not a lag, nothing was syncing that wallet at all.
 *
 * This module decides *which* wallets to catch up and *how many at once*. It does not sync anything —
 * that keeps the policy testable without a chain, a store or a clock.
 *
 * @module
 */

/** Identifies one wallet+account for freshness purposes. Network is implied by the caller's scope. */
export type SyncCandidate = {
  readonly groupId: string
  readonly accountIndex: number
}

/** The map key a candidate is recorded under. */
export const freshnessKey = (groupId: string, accountIndex: number): string => `${groupId}:${accountIndex}`

/**
 * How long a non-active wallet may go without a sync before it is due one.
 *
 * Ten minutes is a compromise, not a measurement: long enough that a handful of background wallets
 * cost a few indexer reads an hour, short enough that "I looked at this an hour ago" is never the
 * explanation for a wrong number. An agent reading a balance gets a fresher guarantee than this
 * anyway — serving refreshes every granted scope when it starts.
 */
export const STALE_AFTER_MS = 10 * 60_000

/**
 * At most this many background wallets per tick.
 *
 * ⚠️ **One.** These are the wallets nobody is looking at; catching them all up at once would put N
 * indexer reads and N folds on the same tick as the active wallet's own sync, which is the one that
 * has to stay responsive. A queue that drains one per tick reaches every wallet quickly enough and is
 * never the reason a tick is slow.
 */
export const MAX_BACKGROUND_PER_TICK = 1

/**
 * The wallets to refresh on this tick, oldest first.
 *
 * The active wallet is never returned: something else already keeps it current, and syncing it here
 * would race that.
 *
 * A wallet with no recorded sync sorts before every wallet that has one — it is the least known, and
 * after a restart it is *every* wallet, which is exactly when catching up matters most.
 */
export const dueForBackgroundSync = (params: {
  readonly candidates: readonly SyncCandidate[]
  /** The wallet kept permanently current, as a {@link freshnessKey}, or `null` when there is none. */
  readonly activeKey: string | null
  /** When each wallet last synced successfully, by {@link freshnessKey}. */
  readonly lastSyncedAt: ReadonlyMap<string, number>
  readonly now: number
  readonly staleAfterMs?: number
  readonly maxPerTick?: number
}): readonly SyncCandidate[] => {
  const staleAfter = params.staleAfterMs ?? STALE_AFTER_MS
  const limit = params.maxPerTick ?? MAX_BACKGROUND_PER_TICK
  if (limit <= 0) return []

  const due = params.candidates
    .filter((candidate) => {
      const key = freshnessKey(candidate.groupId, candidate.accountIndex)
      if (key === params.activeKey) return false
      const last = params.lastSyncedAt.get(key)
      return last === undefined || params.now - last >= staleAfter
    })
    // Oldest first, never-synced before everything. `-Infinity` rather than 0 so a clock at the epoch
    // cannot accidentally outrank "never".
    .sort((a, b) => {
      const at = params.lastSyncedAt.get(freshnessKey(a.groupId, a.accountIndex)) ?? Number.NEGATIVE_INFINITY
      const bt = params.lastSyncedAt.get(freshnessKey(b.groupId, b.accountIndex)) ?? Number.NEGATIVE_INFINITY
      return at - bt
    })

  return due.slice(0, limit)
}

/**
 * How stale a wallet is, in ms, or `null` when it has never synced.
 *
 * Exposed so a surface can *say* how old a figure is instead of presenting it as current — the
 * distinction that was missing when a twelve-hour-old balance rendered exactly like a fresh one.
 */
export const stalenessOf = (params: {
  readonly groupId: string
  readonly accountIndex: number
  readonly lastSyncedAt: ReadonlyMap<string, number>
  readonly now: number
}): number | null => {
  const last = params.lastSyncedAt.get(freshnessKey(params.groupId, params.accountIndex))
  return last === undefined ? null : Math.max(0, params.now - last)
}

/**
 * When each wallet last synced successfully, this session.
 *
 * ⚠️ **In memory, deliberately.** Persisting it would make "fresh" survive a restart, and a restart is
 * exactly when nothing is known: the process has no feed, no cache in hand and no idea what moved
 * while it was gone. Starting empty means every wallet is due on the first ticks, drained one per
 * tick, which is the behaviour worth having.
 */
const lastSynced = new Map<string, number>()

/** Record a successful sync. Called by the sync itself, so no caller can forget. */
export const recordSync = (groupId: string, accountIndex: number, at: number): void => {
  lastSynced.set(freshnessKey(groupId, accountIndex), at)
}

/** The record, for {@link dueForBackgroundSync} and {@link stalenessOf}. */
export const syncFreshness = (): ReadonlyMap<string, number> => lastSynced

/** Forget everything — a network switch invalidates every wallet's freshness along with its cache. */
export const forgetSyncFreshness = (): void => {
  lastSynced.clear()
}

/**
 * Every enabled account of every group, on one chain — the unit both the background scheduler and any
 * cross-wallet read work in.
 *
 * ⚠️ **Never assume account 0.** `AccountEntry` carries `enabled` precisely because a wallet can sync
 * more than one, and a pinned index reads the wrong account with nothing failing — the class
 * `no-pinned-account.test.ts` exists to stop, and which it has already caught once here.
 *
 * Extracted from `WalletProvider` so the rule has a test rather than a comment. It is worth one:
 * this exact loop shipped pinned to account 0 once, and nothing failed — the scheduler simply kept
 * an account nobody uses fresh while the real one went stale.
 */
export const enabledAccountsOn = (
  groups: Iterable<{
    readonly groupId: string
    readonly chains: ReadonlyMap<
      string,
      {readonly accounts: readonly {readonly index: number; readonly enabled: boolean}[]}
    >
  }>,
  chainId: string,
): readonly SyncCandidate[] =>
  [...groups].flatMap((group) =>
    (group.chains.get(chainId)?.accounts ?? [])
      .filter((account) => account.enabled)
      .map((account) => ({groupId: group.groupId, accountIndex: account.index})),
  )
