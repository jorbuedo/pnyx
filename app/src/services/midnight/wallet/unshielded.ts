/**
 * Bring a funds group's unshielded UTxO set up to date, and cache it.
 *
 * ⚠️ **No vault, no biometrics.** Unlike the shielded sync, nothing here decrypts anything: unshielded
 * UTxOs are addressed in the clear, so the address alone is enough to read them. That is why this can run
 * on screen focus while `syncShieldedWallet` must be user-initiated — and why the two stay separate
 * functions rather than one "sync Midnight" that would drag a prompt into the cheap half.
 *
 * @module
 */

import {Effect} from 'effect'

import {logger} from '../../../logger'
import {mergeActivityByTransaction} from './midnight-activity'
import {settlePendingSends} from './settle-pending-sends'
import {recordSync} from './sync-freshness'
import {awaitFeedCaughtUp, feedKey, feedOwns} from './unshielded-live'
import {unshieldedUtxoId} from './unshielded-pending-store'
import {spendableUnshielded} from './unshielded-spendable'
import {
  loadUnshieldedCache,
  saveUnshieldedCache,
  type UnshieldedCache,
  type UnshieldedStoreError,
} from './unshielded-store'
import {syncUnshielded, type UnshieldedSyncError} from './unshielded-sync'
import {totalsByToken} from './unshielded-utxo-set'

const ORIGIN = 'midnight-unshielded'

export type UnshieldedSyncOutcome = {
  readonly utxoCount: number
  /** The set itself, for a surface that lists UTxOs rather than totalling them. */
  readonly utxos: readonly import('./unshielded-utxo-set').UnshieldedUtxo[]
  /** Newest first. Includes what the cache already held, not just this run's replay. */
  readonly activity: readonly import('./midnight-activity').MidnightActivity[]
  readonly totals: ReadonlyMap<string, bigint>
  readonly transactionsApplied: number
  readonly caughtUp: boolean
}

/**
 * The outcome, taken from a feed that already owns this wallet.
 *
 * ⚠️ **`transactionsApplied` is 0 here and that is not a count of nothing.** A feed applies
 * continuously, so "how many did *this call* apply" has no answer — the question only made sense for a
 * one-shot that opened a socket, read, and closed it. A caller deciding whether anything changed must
 * watch the projection instead of asking a synchronous function; `syncMidnightUnshielded` does exactly
 * that by declining to run at all while a feed is up.
 *
 * A feed that does not reach catch-up in time falls back to the **cache**, never to a competing socket:
 * a slow feed is still the writer, and the cache is a read.
 */
const fromLiveFeed = (
  key: string,
  params: {
    readonly groupId: string
    readonly accountIndex: number
    readonly address: string
    readonly timeoutMs?: number
  },
): Effect.Effect<UnshieldedSyncOutcome, UnshieldedStoreError> =>
  Effect.gen(function* () {
    // ⚠️ The caller's deadline applies here too. It used to reach only the one-shot socket, so a caller
    // asking not to be kept waiting was obeyed on one path and silently ignored on the other — and this
    // is the slower path, because it waits out a replay instead of starting one.
    const live = yield* params.timeoutMs === undefined
      ? awaitFeedCaughtUp(key)
      : awaitFeedCaughtUp(key, params.timeoutMs)
    if (live === undefined) {
      logger.warn('the unshielded feed owns this wallet but has not caught up; answering from the cache', {
        origin: ORIGIN,
        groupId: params.groupId,
      })
      const cached = yield* readCachedUnshielded(params)
      const fallback = yield* spendableUnshielded(params.groupId, params.accountIndex, [
        ...(cached?.utxos.values() ?? []),
      ])
      return {
        utxoCount: fallback.length,
        utxos: fallback,
        activity: cached?.activity ?? [],
        totals: totalsByToken(new Map(fallback.map((utxo) => [unshieldedUtxoId(utxo), utxo]))),
        transactionsApplied: 0,
        caughtUp: false,
      }
    }
    const spendable = yield* spendableUnshielded(params.groupId, params.accountIndex, [...live.utxos.values()])
    return {
      utxoCount: spendable.length,
      utxos: spendable,
      activity: live.activity,
      totals: totalsByToken(new Map(spendable.map((utxo) => [unshieldedUtxoId(utxo), utxo]))),
      transactionsApplied: 0,
      caughtUp: live.caughtUp,
    }
  })

/**
 * Sync and cache. Fails when the read could not be made — a caller must be able to tell "this address
 * holds nothing" from "we could not ask", because the two render identically otherwise.
 *
 * Resumes from the cached cursor when one exists for this exact address, so a repeat sync costs the
 * transactions since the last one rather than the whole history.
 */
/**
 * How long a money path waits for the rail to catch up before refusing.
 *
 * Short on purpose, and only defensible *because* the caller now refuses a set that is not caught up
 * (`requireCaughtUp`): waiting the full default only to answer `not-ready` anyway is strictly worse than
 * saying so at once. It is not zero because a resume replays just the transactions since its cursor and
 * the indexer's first progress frame lands in well under a second — so this succeeds in the ordinary
 * case and gives up quickly on a genuine first sync, which is unbounded and not worth blocking a send.
 */
export const SPEND_CATCH_UP_TIMEOUT_MS = 5_000

export const syncUnshieldedWallet = (params: {
  readonly groupId: string
  readonly accountIndex: number
  readonly address: string
  readonly network: string | null
  readonly timeoutMs?: number
}): Effect.Effect<UnshieldedSyncOutcome, UnshieldedSyncError | UnshieldedStoreError> =>
  Effect.gen(function* () {
    // ⚠️ **Defer to a running feed rather than open a second socket.** While a feed owns this key it is
    // the only writer of the cache; a one-shot alongside it would race the same blob and could store a
    // set the feed had already moved past. The feed is also further ahead by construction — it never
    // stopped listening.
    if (params.network !== null) {
      const key = feedKey(params.groupId, params.accountIndex, params.network)
      if (feedOwns(key)) return yield* fromLiveFeed(key, params)
    }

    const cached = yield* readCachedUnshielded({
      groupId: params.groupId,
      accountIndex: params.accountIndex,
      address: params.address,
    })
    const result = yield* syncUnshielded({
      address: params.address,
      network: params.network,
      ...(cached === undefined ? {} : {from: {utxos: cached.utxos, transactionId: cached.transactionId}}),
      ...(params.timeoutMs === undefined ? {} : {timeoutMs: params.timeoutMs}),
    })

    // Newest first, and merged with what the cache already holds: a resume replays only the transactions
    // since the cursor, so dropping the older ones would shorten the history on every sync.
    const replayed = [...result.activity].reverse()
    const seen = new Set(replayed.map((a) => a.transactionId))
    for (const previous of cached?.activity ?? []) {
      if (!seen.has(previous.transactionId)) replayed.push(previous)
    }
    // ⚠️ One row per transaction, not per event. The dedup above is by `transactionId`, which the two
    // events of a self-send do not share — only the hash does. Without this a self-send renders twice
    // and each row under-reports what moved, because each event carries only its own half.
    const merged = mergeActivityByTransaction(replayed)

    const next: UnshieldedCache = {
      utxos: result.utxos,
      activity: merged,
      // Keep the cursor we resumed from when the indexer named no higher one; moving it backwards would
      // replay history we have already folded, and moving it forward on no evidence would skip history.
      transactionId: result.highestTransactionId ?? cached?.transactionId ?? 0,
      address: params.address,
    }
    yield* saveUnshieldedCache(params.groupId, params.accountIndex, next)
    yield* settlePendingSends(params.groupId, params.accountIndex, merged, params.network)

    // Spendable, not confirmed. An input an in-flight transaction already took must not be selected
    // again, and it must not be counted either — a balance that includes it promises money the chain has
    // been asked to move. Applied here rather than at each selection site so the five callers cannot
    // drift, and so a widget and the selector answer the same question.
    const spendable = yield* spendableUnshielded(params.groupId, params.accountIndex, [...result.utxos.values()])
    const totals = totalsByToken(new Map(spendable.map((utxo) => [unshieldedUtxoId(utxo), utxo])))
    // Recorded here rather than at each call site: five callers sync, and a freshness record only one
    // of them updates is worse than none — a wallet would look current because something else synced.
    recordSync(params.groupId, params.accountIndex, Date.now())
    logger.info('unshielded sync stored', {
      origin: ORIGIN,
      groupId: params.groupId,
      utxos: result.utxos.size,
      applied: result.transactionsApplied,
      tokens: totals.size,
      activity: merged.length,
      caughtUp: result.caughtUp,
    })

    return {
      utxoCount: spendable.length,
      utxos: spendable,
      activity: merged,
      totals,
      transactionsApplied: result.transactionsApplied,
      caughtUp: result.caughtUp,
    }
  })

/**
 * The cached set without touching the network. `undefined` when nothing has been read — which is not the
 * same as an empty wallet, and must not be rendered as a zero.
 *
 * ⚠️ `address` is **optional on purpose.** Resolving a group's Midnight address goes through the wallet
 * service and measured ~7 s on a cold start; making this read wait for it meant every reload showed
 * nothing for that whole time, for data already on disk and readable in 70 ms. The blob stores the address
 * it belongs to, so a caller paints from disk first and passes the address once it has one — a mismatch
 * then drops the cache.
 */
/**
 * The cached set with in-flight locks applied — what a **balance** should show.
 *
 * Separate from {@link readCachedUnshielded} rather than filtering inside it, because that function is
 * also the resume base for the next sync: folding new transactions onto a filtered set would drop the
 * locked UTxOs from the cache permanently, which is a far worse bug than the one this fixes.
 *
 * Display and selection have to agree, or a screen offers to spend an output the selector has already
 * set aside. Selection gets the overlay through `syncUnshieldedWallet`; this is the other half.
 */
export const readSpendableUnshielded = (params: {
  readonly groupId: string
  readonly accountIndex: number
  readonly address?: string | undefined
}): Effect.Effect<UnshieldedCache | undefined, UnshieldedStoreError> =>
  Effect.gen(function* () {
    const cached = yield* readCachedUnshielded(params)
    if (cached === undefined) return undefined
    const spendable = yield* spendableUnshielded(params.groupId, params.accountIndex, [...cached.utxos.values()])
    return {...cached, utxos: new Map(spendable.map((utxo) => [unshieldedUtxoId(utxo), utxo]))}
  })

export const readCachedUnshielded = (params: {
  readonly groupId: string
  readonly accountIndex: number
  readonly address?: string | undefined
}): Effect.Effect<UnshieldedCache | undefined, UnshieldedStoreError> =>
  Effect.gen(function* () {
    const cached = yield* loadUnshieldedCache(params.groupId, params.accountIndex)
    if (cached === undefined) return undefined
    if (params.address !== undefined && cached.address !== params.address) {
      logger.debug('unshielded cache belongs to another address; ignoring it', {
        origin: ORIGIN,
        groupId: params.groupId,
      })
      return undefined
    }
    return cached
  })

export {spendableUnshielded} from './unshielded-spendable'
