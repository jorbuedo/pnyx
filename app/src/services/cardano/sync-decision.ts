/**
 * Watermark decision for the storage-first sync policy (see
 * `docs/CARDANO_DATA_SYNC.md`). Pure — no I/O.
 *
 * The cheap "did anything change?" probe is the newest transaction touching any
 * of the wallet's addresses. A new tx (input or output) always changes the
 * newest `(blockHeight, txHash)`, so an unchanged watermark means the confirmed
 * UTxO set is unchanged and a full refetch can be skipped.
 *
 * @module
 */

import {type Provider, TransactionHash} from '@evolution-sdk/evolution'

/** Newest confirmed tx across the synced addresses, or `null` when none yet. */
export type SyncWatermark = {
  readonly newestTxHash: string
  readonly newestBlockHeight: number | null
} | null

/**
 * Derive the watermark from a newest-first tx-ref list (what
 * `provider.txsAt(addrs, {limit: 1})` returns). Empty ⇒ `null` (no history).
 */
export const watermarkOf = (refs: readonly Provider.IndexedTxRef[]): SyncWatermark => {
  const newest = refs[0]
  if (newest === undefined) return null
  // ⚠️ The hash is hex here because a watermark is PERSISTED and compared against a stored one.
  // Evolution reports it as a `TransactionHash`, so this is the edge where a typed value becomes
  // a storage format, and the conversion belongs here rather than deeper in.
  return {newestTxHash: TransactionHash.toHex(newest.txHash), newestBlockHeight: newest.blockHeight ?? null}
}

/**
 * Whether the confirmed set must be refetched. True on the first sync
 * (`prev === null`), and whenever the newest tx differs (hash or block height).
 * An unchanged watermark ⇒ serve from the existing confirmed set, no fetch.
 */
export const watermarkChanged = (prev: SyncWatermark, next: SyncWatermark): boolean => {
  if (prev === null) return true
  if (next === null) return true
  return prev.newestTxHash !== next.newestTxHash || prev.newestBlockHeight !== next.newestBlockHeight
}

/**
 * Whether a completed refetch may advance the stored watermark.
 *
 * The watermark asserts "the confirmed set reflects everything up to here", and
 * it is what suppresses every future refetch. Advancing it on a fetch that did
 * not actually bring the change in is therefore permanent: the probe never moves
 * again until some *other* transaction happens, and the balance stays wrong in
 * the meantime.
 *
 * That is not hypothetical — it is what a shared wallet's first spend hit on
 * preprod. The probe reads the transaction index and the fetch reads the UTxO
 * index, and the two do not update together: the probe saw the spend, the fetch
 * came back with the pre-spend set, and the watermark moved past a change the
 * wallet had not absorbed. The wallet then showed its old balance indefinitely.
 *
 * So the rule is: only claim to have caught up when the fetch changed something,
 * or when there was no watermark to begin with. The cost of the exception is one
 * repeated fetch per sync interval for a transaction that genuinely leaves the
 * set alone; the cost of the alternative is a wallet that lies about its balance
 * until it is next spent from.
 */
export const canAdvanceWatermark = (args: {
  /** False when the probe failed or the provider indexes no history. */
  readonly probed: boolean
  readonly previous: SyncWatermark
  /** Whether the refetch changed the confirmed UTxO set. */
  readonly setChanged: boolean
}): boolean => args.probed && (args.setChanged || args.previous === null)

/**
 * Whether the history walk can be skipped as already-current.
 *
 * | newest hash | checkpoint | stored rows | backfill | skip |
 * |---|---|---|---|---|
 * | unknown (no history surface) | any | any | any | no |
 * | known | absent or different | any | any | no |
 * | known | same | none | any | **no** |
 * | known | same | some | **not finished** | **no** |
 * | known | same | some | finished | yes |
 *
 * The "no stored rows" row: the checkpoint lives in the key-value store while the rows live in the tx
 * table, so a dropped table with a surviving checkpoint would otherwise claim "already current" over an
 * empty history and never walk again.
 *
 * ⚠️ **The backfill row is why a dormant account's history stopped where it stopped.** The newest hash
 * answers "has anything happened *since*", which is the wrong question for a walk that has not yet
 * reached the *bottom*. A wallet mid-backfill whose account then goes quiet has an unchanging newest
 * hash, so the gate fired on every tick and the descent never resumed — observed on a restored wallet
 * whose history was truncated at height 13,513,865, with the checkpoint reading `complete: false`
 * forever. The plan below already handles the case correctly; it was never reached.
 */
export const canSkipHistoryWalk = (args: {
  readonly newestTxHash: string | undefined
  readonly checkpointTxHash: string | undefined
  readonly hasStoredRows: boolean
  /** From {@link backfillComplete} over the same checkpoint. A partial descent is never "current". */
  readonly backfillComplete: boolean
}): boolean =>
  args.newestTxHash !== undefined &&
  args.checkpointTxHash === args.newestTxHash &&
  args.hasStoredRows &&
  args.backfillComplete

/**
 * Combine per-batch watermarks into the newest one across all of them.
 *
 * Must be deterministic for a given chain state, or the watermark flaps between
 * syncs and every sync refetches: highest block height wins, ties break on the
 * greater hash, and a height-less entry never outranks one with a height.
 */
export const newestWatermark = (watermarks: readonly SyncWatermark[]): SyncWatermark => {
  let best: SyncWatermark = null
  for (const candidate of watermarks) {
    if (candidate === null) continue
    if (best === null) {
      best = candidate
      continue
    }
    const bestHeight = best.newestBlockHeight
    const height = candidate.newestBlockHeight
    if (height === null && bestHeight !== null) continue
    if (
      (height !== null && bestHeight === null) ||
      (height ?? 0) > (bestHeight ?? 0) ||
      ((height ?? 0) === (bestHeight ?? 0) && candidate.newestTxHash > best.newestTxHash)
    ) {
      best = candidate
    }
  }
  return best
}

/**
 * How far back a walk re-enumerates, in blocks, when it goes incremental.
 *
 * A new transaction always sits at or above the newest height we enumerated, so in principle `afterBlock
 * = newestBlockHeight` would do. The margin covers the two cases where that is not quite true: another
 * transaction in the *same* block that the indexer had not yet returned, and a shallow rollback that
 * re-mints recent blocks. Overlap costs nothing — `saveTxRows` is an upsert keyed by hash — so this is
 * paid in a few extra refs, not in duplicate rows.
 */
export const REORG_MARGIN_BLOCKS = 10

/**
 * How long an incremental chain may run before a reconciliation pass re-reads recent history.
 *
 * The incremental path cannot see a rollback deeper than {@link REORG_MARGIN_BLOCKS}, and no cheap probe
 * can tell us one happened. So rather than trust the fast path indefinitely, this bounds the drift: once
 * a day, re-enumerate the rollback window and find out.
 */
export const FULL_WALK_INTERVAL_MS = 24 * 3600_000

/**
 * Cardano's rollback bound, in blocks (~12 h at 20 s/block).
 *
 * Anything deeper is immutable by protocol, so re-enumerating it buys nothing — which is why
 * reconciliation re-reads *this* much rather than the whole account. The `periodic-full` plan it
 * replaced re-walked everything daily, which on a large account is a walk that cannot finish.
 */
export const ROLLBACK_BOUND_BLOCKS = 2160

/**
 * The first backfill window's span, in blocks.
 *
 * Measured against Koios for a stake account with ~490,000 addresses: a window this size just below
 * the tip answers in **1.4–1.7 s**.
 */
export const INITIAL_WINDOW_BLOCKS = 50_000

/** Ceiling on a window's span. Beyond this a single request's response outgrows the page cap. */
export const MAX_WINDOW_BLOCKS = 1_000_000

/**
 * How wide a backfill window starting `blocksBelowTip` under the account's newest transaction should be.
 *
 * ⚠️ **Cost is set by depth, not by span** — the measurement that shapes this. Koios applies
 * `block_height=lt.…` *after* the query `_after_block_height` drives, so the same 1,000-block span costs
 * **1.4 s** near the tip and **30.7 s** three million blocks down. Fixed-width windows therefore get
 * steadily more expensive as the walk descends, and a 6.66M-block account would pay that price ~130
 * times over.
 *
 * Since the price is per *request*, the answer is to make deep requests rarer rather than smaller: the
 * span grows with depth, so the number of windows is logarithmic in the history's length (~22 for the
 * account measured) instead of linear. Near the tip it stays at {@link INITIAL_WINDOW_BLOCKS}, where
 * latency matters and requests are cheap.
 */
export const windowSpanFor = (blocksBelowTip: number): number =>
  Math.min(MAX_WINDOW_BLOCKS, Math.max(INITIAL_WINDOW_BLOCKS, Math.floor(blocksBelowTip / 4)))

/** What the checkpoint carries about a previous walk's reach. */
export type HistoryReach = {
  readonly newestBlockHeight?: number
  readonly complete?: boolean
  readonly fullWalkAt?: number
  /**
   * The lowest block height a backfill has enumerated down to, exclusive.
   *
   * ⚠️ **Persisted per window, not at the end of a walk** — the whole point. A walk that cannot finish
   * in one run is exactly the one whose progress must survive, and the previous checkpoint was written
   * once, after the loop, guarded on a probe that times out on a large account. So a wallet whose walk
   * could not complete recorded nothing, planned `first-sync` again on every tick, and never advanced.
   */
  /**
   * How many transactions the walk that wrote this checkpoint accounted for.
   *
   * Load-bearing for the empty-account case: an empty tx table is evidence of a *dropped* table only
   * when a previous walk said there was something in it.
   */
  readonly txCount?: number
  readonly oldestEnumeratedHeight?: number
  /**
   * The height of the account's oldest transaction — the floor a backfill walks down to.
   *
   * Read once with an ascending `limit: 1` query. Without it the walk cannot tell an account that
   * *starts* at block 7.2M from one with a gap, so it would descend to zero through empty history,
   * paying the deep-request price for windows that can never hold anything.
   */
  readonly firstTxHeight?: number
}

export type HistoryWalkPlan = {
  /** Exclusive lower bound. `undefined` ⇒ no lower bound (enumerate from the beginning). */
  readonly afterBlock: number | undefined
  /**
   * Exclusive upper bound. `undefined` ⇒ up to the tip.
   *
   * ⚠️ Required for a backfill to descend at all: without it every window returns the newest rows
   * above `afterBlock`, which the walk already has, and it never reaches older history.
   */
  readonly beforeBlock: number | undefined
  /** Why this plan, for the log line and for the tests to assert on. */
  readonly reason: 'first-sync' | 'no-stored-rows' | 'backfill' | 'reconcile' | 'incremental'
}

/**
 * Whether to ask the indexer for the account's oldest transaction height.
 *
 * That height is the floor a backfill descends to. Without one the walk keeps stepping
 * backwards until it runs out of chain — on mainnet, from the tip through ~13.9M blocks.
 *
 * ⚠️ **Not gated on a whole-account watch.** The probe shares its stake-keyed query with
 * history *enumeration*, and the two were gated together. They are different questions.
 * Enumeration needs `accountUtxoMode: 'all'`, because an address merely sharing our stake
 * credential is not necessarily ours. A floor does not: our addresses carry this stake
 * credential in their own bytes, so every transaction of ours belongs to this account and
 * the account's oldest is at or below ours. Using it can only stop the walk early at a
 * point we would never have needed to pass — a lower bound, and a safe one.
 *
 * What the shared gate cost: a CIP-1854 shared wallet's rail never sets `'all'`, so a
 * wallet minutes old with one transaction backfilled toward genesis, seconds per window,
 * against a rate-limited indexer.
 */
export const shouldProbeHistoryFloor = (params: {
  /** Already known and carried in the checkpoint — a fact about history, asked once. */
  readonly knownFirstTxHeight: number | undefined
  /** The account's reward address; `null` when watching a bare address with no account. */
  readonly hasRewardAddress: boolean
  /** Whether the provider implements the stake-keyed transaction listing at all. */
  readonly hasAccountTxs: boolean
}): boolean => params.knownFirstTxHeight === undefined && params.hasRewardAddress && params.hasAccountTxs

/**
 * Whether a backfill has reached the bottom of the account's history.
 *
 * `complete` is that and nothing else: the walk has enumerated down past the account's oldest
 * transaction. It replaces the old "a page came back short" test, which said only that one *request*
 * ran out of rows — true of every window, and so never evidence about the history as a whole.
 */
export const backfillComplete = (reach: HistoryReach | null | undefined): boolean => {
  if (reach === null || reach === undefined) return false
  const oldest = reach.oldestEnumeratedHeight
  // ⚠️ Migration: a checkpoint written before the walk became windowed carries no floor, and its
  // `complete` meant "the walk enumerated to exhaustion" — which under the old unbounded plan *was* the
  // whole history. Honouring it keeps every wallet that had already finished from re-walking from
  // scratch. The accounts this change exists for never got to write one, so none of them is affected.
  if (oldest === undefined) return reach.complete === true
  const first = reach.firstTxHeight
  // An account whose floor is unknown is only provably done at the beginning of the chain.
  if (first === undefined) return oldest === 0
  return oldest <= first
}

/**
 * The next window to walk.
 *
 * | checkpoint | stored rows | backfill | plan |
 * |---|---|---|---|
 * | absent | any | — | `first-sync` — the newest window, no upper bound |
 * | present, `txCount > 0` | **none** | — | `no-stored-rows` — the newest window again |
 * | present | some | not finished | `backfill` — the next window *below* what has been enumerated |
 * | present | some | finished, reconcile due | `reconcile` — the rollback window, no upper bound |
 * | present | some | finished, fresh | `incremental` — from the newest height less the reorg margin |
 *
 * ⚠️ **The "no stored rows" row is not defensive noise.** The checkpoint lives in a key-value store and
 * the rows live in the tx table, so the table can be dropped while the checkpoint survives — and an
 * incremental plan would then fetch only recent transactions and mark *itself* complete, leaving the
 * history permanently truncated with nothing to signal it. `canSkipHistoryWalk` guards the same pair for
 * the same reason.
 *
 * `newestTxHeight` is the top of the account's history, from the same probe that produced the
 * watermark. It is used rather than the chain tip so the first window is not mostly empty space above
 * the account's last transaction.
 */
export const historyWalkPlan = (args: {
  readonly checkpoint: HistoryReach | null | undefined
  readonly hasStoredRows: boolean
  /** The account's newest transaction height, or `undefined` when the probe could not say. */
  readonly newestTxHeight: number | undefined
  readonly nowMs: number
  readonly reorgMarginBlocks?: number
  readonly fullWalkIntervalMs?: number
}): HistoryWalkPlan => {
  const {checkpoint, hasStoredRows, newestTxHeight, nowMs} = args
  const margin = args.reorgMarginBlocks ?? REORG_MARGIN_BLOCKS
  const interval = args.fullWalkIntervalMs ?? FULL_WALK_INTERVAL_MS

  /** The newest window: everything above `top − span`, with nothing above it. */
  const newestWindow = (reason: HistoryWalkPlan['reason']): HistoryWalkPlan =>
    newestTxHeight === undefined
      ? {afterBlock: undefined, beforeBlock: undefined, reason}
      : {afterBlock: Math.max(0, newestTxHeight - INITIAL_WINDOW_BLOCKS), beforeBlock: undefined, reason}

  if (checkpoint === null || checkpoint === undefined) return newestWindow('first-sync')
  // ⚠️ An empty table is only *evidence* when a previous walk claimed to have filled it. An account
  // with no transactions has an empty table by definition, and treating that as a dropped table left it
  // replanning `no-stored-rows` for ever — observed on a freshly restored wallet with no history.
  if (!hasStoredRows && (checkpoint.txCount ?? 0) > 0) return newestWindow('no-stored-rows')

  if (!backfillComplete(checkpoint)) {
    const ceiling = checkpoint.oldestEnumeratedHeight
    // Nothing enumerated yet under a checkpoint that exists: start at the top rather than guess a floor.
    if (ceiling === undefined) return newestWindow('first-sync')
    const top = checkpoint.newestBlockHeight ?? newestTxHeight ?? ceiling
    const span = windowSpanFor(Math.max(0, top - ceiling))
    const floor = checkpoint.firstTxHeight ?? 0
    return {afterBlock: Math.max(floor, ceiling - span), beforeBlock: ceiling, reason: 'backfill'}
  }

  // Below here the history is enumerated end to end, so only the recent end can still change.
  //
  // ⚠️ The anchor is the height *we enumerated*, not the one the probe reports. They differ exactly when
  // the account has moved on since the last walk — and starting from the probe's height would skip
  // every transaction between the two. Starting lower only ever costs a re-read, which upserts.
  const anchor = checkpoint.newestBlockHeight ?? newestTxHeight
  if (nowMs - (checkpoint.fullWalkAt ?? 0) >= interval) {
    return {
      afterBlock: anchor === undefined ? undefined : Math.max(0, anchor - ROLLBACK_BOUND_BLOCKS),
      beforeBlock: undefined,
      reason: 'reconcile',
    }
  }
  return {
    afterBlock: anchor === undefined ? undefined : Math.max(0, anchor - margin),
    beforeBlock: undefined,
    reason: 'incremental',
  }
}

/**
 * The checkpoint to persist after **one window**.
 *
 * ⚠️ **This is called per window, and its result must be written per window.** The previous version ran
 * once after the whole walk and the caller guarded the write on the change-probe having succeeded —
 * which is how a large account came to record nothing at all: its probe times out, so `newestTxHash`
 * was `undefined`, so nothing was ever saved, so every tick planned a first sync and re-walked history
 * that cannot be walked in one run. Progress is now recorded as it is made, and the probe's failure
 * costs only the skip optimisation it feeds.
 *
 * `oldestEnumeratedHeight` only moves **down**, and only when the window's rows were all persisted:
 * claiming to have enumerated a window whose writes failed would leave a hole nothing goes back for.
 * `newestBlockHeight` only moves **up**, so an incremental window that legitimately returns nothing
 * does not reset the reach it inherited.
 */
export const nextHistoryCheckpoint = (args: {
  readonly previous: HistoryReach | null | undefined
  /** From the change probe. `undefined` when it failed — which must not stop the write. */
  readonly newestTxHash: string | undefined
  readonly previousTxHash?: string | undefined
  readonly txCount: number
  /** The highest height among the refs this window saw, or `undefined` if it saw none. */
  readonly maxBlockHeightSeen: number | undefined
  /** The window's exclusive lower bound; `undefined` ⇒ it had none, so it reached the beginning. */
  readonly windowFloor: number | undefined
  /** The account's oldest transaction height, once known. */
  readonly firstTxHeight: number | undefined
  /** Every page this window persisted was written without error. */
  readonly persistedAll: boolean
  /** This window was the reconciliation pass over the rollback bound. */
  readonly wasReconcile: boolean
  readonly nowMs: number
}): {
  readonly blockHash: string
  readonly txHash: string
  readonly txCount: number
  readonly newestBlockHeight?: number
  readonly complete: boolean
  readonly fullWalkAt?: number
  readonly oldestEnumeratedHeight?: number
  readonly firstTxHeight?: number
} => {
  const previous = args.previous
  const inheritedHeight = previous?.newestBlockHeight
  const newestBlockHeight =
    args.maxBlockHeightSeen === undefined ? inheritedHeight : Math.max(args.maxBlockHeightSeen, inheritedHeight ?? 0)

  // A window with no lower bound reached the beginning of history, so its floor is zero.
  const reachedFloor = args.windowFloor ?? 0
  const inheritedFloor = previous?.oldestEnumeratedHeight
  const oldestEnumeratedHeight = !args.persistedAll
    ? inheritedFloor
    : inheritedFloor === undefined
      ? reachedFloor
      : Math.min(inheritedFloor, reachedFloor)

  const firstTxHeight = args.firstTxHeight ?? previous?.firstTxHeight
  const complete = backfillComplete({
    ...(oldestEnumeratedHeight !== undefined ? {oldestEnumeratedHeight} : {}),
    ...(firstTxHeight !== undefined ? {firstTxHeight} : {}),
  })
  // Stamped when reconciliation ran, and when a backfill first reaches the bottom — otherwise a walk
  // that has just finished would immediately be due for reconciliation.
  const reconciled = (args.wasReconcile || (complete && previous?.complete !== true)) && args.persistedAll
  const fullWalkAt = reconciled ? args.nowMs : previous?.fullWalkAt

  return {
    blockHash: '',
    // The probe failing must not erase the watermark the skip gate compares against.
    txHash: args.newestTxHash ?? args.previousTxHash ?? '',
    txCount: args.txCount,
    ...(newestBlockHeight !== undefined ? {newestBlockHeight} : {}),
    complete,
    ...(fullWalkAt !== undefined ? {fullWalkAt} : {}),
    ...(oldestEnumeratedHeight !== undefined ? {oldestEnumeratedHeight} : {}),
    ...(firstTxHeight !== undefined ? {firstTxHeight} : {}),
  }
}
