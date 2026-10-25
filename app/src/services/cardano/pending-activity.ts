/**
 * Submitted-but-unconfirmed transactions, as the Activity list should show them.
 *
 * The chain is the source of truth for history, and the store is populated only
 * from the indexer — so between pressing Send and the indexer catching up, a
 * transaction the user just authorised was **invisible**. `history-grouping`
 * already pins a leading "Pending" section for rows with no timestamp, and the
 * tx-table already has `status`/`submittedAt` columns; nothing ever produced a
 * row to put there.
 *
 * This overlays the gap rather than writing to the store, mirroring how
 * `PendingTxTracker.spendableView` overlays pending UTxOs on the confirmed set:
 *
 * - **The item is the review the user actually approved.** Not a synthesised
 *   summary — no re-derivation, and nothing to drift from what was consented to.
 * - **The indexed row wins the moment it exists.** An overlay entry whose hash
 *   appears in the store is dropped, so the row never duplicates and never has to
 *   promote itself. That matters because `status: 'confirmed'` may only be claimed
 *   by a producer that read the phase-2 verdict — this one never does.
 * - **Lifetime matches `PendingTxTracker`**, which is in-memory and sweeps at
 *   {@link DEFAULT_PENDING_TIMEOUT_MS}. So a pending row does not survive an app
 *   restart, exactly like the UTxO lock it corresponds to. Persisting one without
 *   persisting the other would show a pending transaction whose inputs are
 *   spendable again.
 *
 * @module
 */

import type {ReviewedTransaction} from '@pnyx/tx-review'
import {DEFAULT_PENDING_TIMEOUT_MS} from '@pnyx/wallet'
import type {CardanoRail} from './rail'

/** One submitted transaction awaiting confirmation. */
export type PendingActivity = {
  readonly hash: string
  /** Epoch millis at submission — drives ordering and expiry. */
  readonly submittedAt: number
  /** The review as approved, with `hash` set and `status: 'pending'`. */
  readonly reviewed: ReviewedTransaction
}

/**
 * Which of `entries` the Activity list should still show, newest-first.
 *
 * Pure: the overlay rule is the part worth testing, and it needs neither a rail
 * nor a store.
 */
export const visiblePendingActivity = (
  entries: readonly PendingActivity[],
  storedHashes: ReadonlySet<string>,
  nowMs: number,
  timeoutMs: number = DEFAULT_PENDING_TIMEOUT_MS,
): readonly PendingActivity[] =>
  entries
    .filter((e) => !storedHashes.has(e.hash) && nowMs - e.submittedAt < timeoutMs)
    .slice()
    .sort((a, b) => b.submittedAt - a.submittedAt)

const railKey = (rail: CardanoRail): string =>
  `${rail.dataRef.groupId}:${rail.dataRef.chainId}:${rail.dataRef.accountIndex}`

/** `${railKey}|${hash}` → entry. Module scope: one overlay per process, like the tracker. */
const entries = new Map<string, PendingActivity>()

const listeners = new Set<() => void>()
const notify = (): void => {
  for (const listener of listeners) listener()
}

/**
 * Observe registrations, so a list that is *already on screen* picks up a
 * transaction submitted after it mounted.
 *
 * Without this the overlay was only visible where the reading hook happened to
 * re-run: the Activity screen, opened fresh after a submit, showed the pending
 * row, while the recent-activity widget on the wallet home — mounted before the
 * submit and no longer polling — never did. Reported from a real combine.
 */
export const onPendingActivityChange = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Record a transaction we just submitted. `reviewed` is stamped with the hash and
 * `status: 'pending'` — the hash exists only after submission, and the absent
 * `timestamp` is what sorts it into the Pending section.
 */
export const registerPendingActivity = (
  rail: CardanoRail,
  hash: string,
  reviewed: ReviewedTransaction,
  submittedAt: number = Date.now(),
): void => {
  entries.set(`${railKey(rail)}|${hash}`, {
    hash,
    submittedAt,
    reviewed: {...reviewed, hash, status: 'pending'},
  })
  notify()
}

/** Forget one entry (the indexer has it, or it was rolled back). */
export const dropPendingActivity = (rail: CardanoRail, hash: string): void => {
  if (entries.delete(`${railKey(rail)}|${hash}`)) notify()
}

/**
 * Forget every entry the store has now caught up with, in one pass.
 *
 * ⚠️ **The overlay's own rule needs a push, not just a pull.** `visiblePendingActivity` already drops
 * an entry whose hash is in the store — but a list only re-applies that when it re-reads, and nothing
 * told an already-mounted list that the store had gained rows. So the Activity screen, which re-reads
 * on focus, cleared its pending row while the home widget kept spinning on the same transaction until
 * the {@link DEFAULT_PENDING_TIMEOUT_MS} sweep or a remount. Dropping here notifies every listener, so
 * both surfaces settle on the same fact at the same moment.
 *
 * Called with whatever the history walk just persisted; hashes it is not waiting on cost one map miss.
 */
export const resolvePendingActivity = (rail: CardanoRail, hashes: readonly string[]): void => {
  const prefix = railKey(rail)
  let dropped = false
  for (const hash of hashes) {
    if (entries.delete(`${prefix}|${hash}`)) dropped = true
  }
  if (dropped) notify()
}

/** Forget everything — network switch, account switch, tests. */
export const clearPendingActivity = (): void => {
  entries.clear()
  notify()
}

/**
 * The pending items to prepend for this rail, given the hashes already read from
 * the store. Expired and superseded entries are dropped from the registry as a
 * side effect, so the overlay cannot grow without bound.
 */
export const pendingActivityFor = (
  rail: CardanoRail,
  storedHashes: ReadonlySet<string>,
  nowMs: number = Date.now(),
): readonly PendingActivity[] => {
  const prefix = `${railKey(rail)}|`
  const mine: PendingActivity[] = []
  for (const [key, entry] of entries) if (key.startsWith(prefix)) mine.push(entry)
  const visible = visiblePendingActivity(mine, storedHashes, nowMs)
  const keep = new Set(visible.map((e) => e.hash))
  for (const entry of mine) if (!keep.has(entry.hash)) entries.delete(`${prefix}${entry.hash}`)
  return visible
}
