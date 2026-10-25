/**
 * Holding the unshielded feed open, and publishing what it says.
 *
 * ⚠️ **There is no fetch for an unshielded balance.** The indexer's `Query` type has no by-address
 * field (see `graphql-ws.ts`), so this rail is a subscription and always was. `syncUnshielded` folds
 * that live feed into a promise and closes the socket at catch-up — which is *why* every surface then
 * has to be told to re-read, and why a widget and its own screen could disagree until one remounted.
 * The wallet was throwing away the connection that was already telling it.
 *
 * This module keeps the feed. A fiber per wallet folds frames as they arrive, writes the durable cache,
 * and publishes into a `SubscriptionRef` that React reads through `useKeyedServiceState`.
 *
 * ## The key carries the network, and that is not cosmetic
 *
 * `loadShieldedState` and `loadConfirmedDustState` check a network *stamp* on every read, because a
 * switch used to hand back the other chain's coins — `state-store.ts` records that as having actually
 * happened. A switch does **not** reload the process (`ConfigProvider.setNetwork` writes storage and
 * calls `setState`), so anything holding parsed state in memory under a network-free key would
 * reintroduce exactly that bug one layer up. The key here is `groupId:accountIndex:network`, so a
 * switch simply finds nothing and the feed for the new network starts clean.
 *
 * ## One writer per key
 *
 * While a feed owns a key it is the **only** writer of that key's cache. {@link feedOwns} exists so the
 * one-shot path can defer to a running feed instead of opening a second socket and racing it into the
 * same blob.
 *
 * ## The durable layer is untouched
 *
 * The cache modules stay exactly as they are and remain the source of truth on disk. This publishes a
 * projection *above* them; it never becomes the thing that is read back after a restart, so a wipe that
 * bypasses these modules cannot be undone by something held here — {@link stopAllUnshieldedFeeds} is
 * what a wipe or a lock calls to make sure nothing is holding anything at all.
 *
 * @module
 */

import {Cause, Effect, Exit, Fiber, Option, Stream, SubscriptionRef} from 'effect'

import {logger} from '../../../logger'
import {onStoreChange} from '../../store-change'
import {midnightIndexerUrlFor} from '../contract-state'
import {type SocketFactory, subscriptionStream} from './graphql-ws'
import {type MidnightActivity, mergeActivityByTransaction} from './midnight-activity'
import {settlePendingSends} from './settle-pending-sends'
import {
  emptyFold,
  foldedActivity,
  foldIsCaughtUp,
  foldUnshieldedFrame,
  type UnshieldedFoldState,
  type UnshieldedFrame,
} from './unshielded-fold'
import {spendableUnshielded} from './unshielded-spendable'
import {loadUnshieldedCache, saveUnshieldedCache, type UnshieldedCache} from './unshielded-store'
import {indexerWsUrl, UNSHIELDED_SUBSCRIPTION, UnshieldedSyncError} from './unshielded-sync'
import type {UnshieldedUtxo} from './unshielded-utxo-set'

const ORIGIN = 'midnight-unshielded-live'

/** `groupId:accountIndex:network` — see the module note on why the network is in here. */
export type FeedKey = string

export const feedKey = (groupId: string, accountIndex: number, network: string): FeedKey =>
  `${groupId}:${accountIndex}:${network}`

/** What a live feed currently believes, for one wallet on one network. */
export type UnshieldedLive = {
  /** What the chain has confirmed. The resume base for the next fold — never filtered. */
  readonly utxos: ReadonlyMap<string, UnshieldedUtxo>
  /**
   * `confirmed − locked`: what a balance should show and a send may select.
   *
   * ⚠️ **Not the same question as `utxos`, and the two must not be conflated.** An input an in-flight
   * transaction already took must not be selected again *and* must not be counted — a balance including
   * it promises money the chain has been asked to move. Filtering `utxos` instead would drop those
   * outputs from the resume base permanently, which is the worse bug of the two.
   */
  readonly spendable: readonly UnshieldedUtxo[]
  /** Newest first, merged. */
  readonly activity: readonly MidnightActivity[]
  readonly address: string
  /**
   * False until the replay reaches the id the indexer named. A balance rendered from a projection that
   * is not caught up is a partial history, not a small one — a caller must be able to tell.
   */
  readonly caughtUp: boolean
}

/**
 * The published projections.
 *
 * Module-level and created with `runSync`, which is safe because `SubscriptionRef.make` does no I/O.
 * A profile switch reloads the process, so this cannot outlive a profile.
 */
export const unshieldedLive: SubscriptionRef.SubscriptionRef<ReadonlyMap<FeedKey, UnshieldedLive>> = Effect.runSync(
  SubscriptionRef.make<ReadonlyMap<FeedKey, UnshieldedLive>>(new Map()),
)

const fibers = new Map<FeedKey, Fiber.RuntimeFiber<void, never>>()
const lockListeners = new Map<FeedKey, () => void>()

/**
 * How many callers currently want each feed.
 *
 * ⚠️ **Without this, one screen leaving takes the feed away from the others.** Two hooks watch the same
 * wallet — the balance and the activity list — and both mount `useUnshieldedFeed`. Observed on device:
 * opening the UTxO screen and pressing back closed the feed and nothing reopened it, because the
 * surviving consumer's effect had no dependency change to re-run on. Balances then sit still with no
 * error anywhere. Counted here rather than in the hook so it holds across every consumer, present and
 * future.
 */
const readers = new Map<FeedKey, number>()

/**
 * When each feed last heard anything at all — a transaction *or* a heartbeat.
 *
 * ⚠️ **A dead socket does not always say so.** A half-open connection — a backgrounded phone, a NAT
 * rebind, a network change — fires no `close` and no `error`, so the fiber lives, `feedOwns` stays true
 * and `syncUnshieldedWallet` keeps deferring to a projection that stopped moving. A send would then
 * select inputs from a stale UTxO set; the one-shot it replaced always re-read from the wire.
 *
 * The indexer's 30-second heartbeat is what makes this detectable at all. Measured, not assumed: a
 * caught-up address receives the same progress frame at +0.3s, +30.3s, +60.3s…
 */
const lastHeard = new Map<FeedKey, number>()

/**
 * Three missed heartbeats. Long enough that one slow round trip is not a fault, short enough that a
 * send does not build on a set that stopped updating a minute ago.
 */
export const FEED_SILENCE_LIMIT_MS = 95_000

/** First reconnect delay, and the ceiling the backoff climbs to. */
const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 30_000

/**
 * How long to wait before reopening a socket that just ended, given how many attempts have failed
 * back to back.
 *
 * 1s, 2s, 4s … capped at 30s — the indexer's own heartbeat interval, so a permanently unreachable
 * indexer is polled no faster than a healthy one talks. `attempt` is reset by **any** frame, heartbeat
 * included, so a connection that worked and then dropped an hour later retries immediately rather than
 * inheriting the backoff of some earlier outage.
 */
export const reconnectDelayMs = (attempt: number): number =>
  Math.min(RECONNECT_BASE_MS * 2 ** Math.max(0, attempt), RECONNECT_MAX_MS)

/**
 * Why a socket ended, in one line.
 *
 * ⚠️ **Not `String(cause)`.** A `SubscriptionError` carries a Hermes stack, and on device that renders
 * as ~3 KB of bundle URLs per line. That was tolerable while a lost feed was logged once; a loop that
 * reports every attempt would emit it twice a minute, per wallet, for as long as an outage lasts. The
 * failure's own message — `socket error: error`, `socket closed before any payload (…)` — is the part
 * that says anything. A defect has no such message, so it keeps the full rendering.
 */
const endedBecause = (outcome: Exit.Exit<void, unknown>): string => {
  if (!Exit.isFailure(outcome)) return 'the server closed the subscription'
  const failure = Cause.failureOption(outcome.cause)
  return Option.isSome(failure) && failure.value instanceof Error ? failure.value.message : String(outcome.cause)
}

/**
 * Keys whose feed is being opened right now.
 *
 * ⚠️ **`fibers` alone cannot guard this.** `startUnshieldedFeed` checks it, then reads the cache — an
 * `await` — and only then registers the fiber, so two consumers starting in the same tick both pass the
 * check, both open a socket, and the second registration orphans the first fiber with its socket never
 * closed. Seen on device as two "feed opened" lines and no "closed". This set is written before the
 * first yield, which is the only point where the check and the claim are still atomic.
 */
const starting = new Set<FeedKey>()

const dropLockListener = (key: FeedKey): void => {
  lockListeners.get(key)?.()
  lockListeners.delete(key)
}

/**
 * Whether a **live** feed owns this key, and is therefore the only thing that may write its cache.
 *
 * ⚠️ Liveness, not merely existence. A feed that has heard nothing for {@link FEED_SILENCE_LIMIT_MS}
 * has a socket that may be half-open, and answering `true` for it is what would let a send build on a
 * frozen projection. Answering `false` sends the caller down the one-shot path, which re-reads from the
 * wire — the conservative direction, and the behaviour that existed before the feed did.
 */
export const feedOwns = (key: FeedKey, nowMs = Date.now()): boolean => {
  if (!fibers.has(key)) return false
  const heard = lastHeard.get(key)
  return heard !== undefined && nowMs - heard <= FEED_SILENCE_LIMIT_MS
}

/** Whether a fiber is registered at all, live or not — what teardown and restart decisions need. */
export const feedRegistered = (key: FeedKey): boolean => fibers.has(key)

/** How many consumers are holding a feed open. Exposed for tests, which is the only honest way to pin it. */
export const feedReaders = (key: FeedKey): number => readers.get(key) ?? 0

const publish = (key: FeedKey, value: UnshieldedLive): Effect.Effect<void> =>
  SubscriptionRef.update(unshieldedLive, (all) => new Map(all).set(key, value))

const forget = (key: FeedKey): Effect.Effect<void> =>
  SubscriptionRef.update(unshieldedLive, (all) => {
    const next = new Map(all)
    next.delete(key)
    return next
  })

/** Lay newer rows over older ones, one row per transaction. Both sides newest-first. */
const overlay = (
  newer: readonly MidnightActivity[],
  older: readonly MidnightActivity[],
): readonly MidnightActivity[] => {
  const seen = new Set(newer.map((a) => a.transactionId))
  return [...newer, ...older.filter((a) => !seen.has(a.transactionId))]
}

/**
 * Merge this connection's activity over what earlier connections folded, and that over the cache.
 *
 * A resume replays only the transactions after the stored cursor, so dropping the older ones would
 * shorten the history on every reconnect.
 *
 * ⚠️ **`carried` is a separate layer and not more `state.activity`, because merging is a sum.**
 * `foldedActivity` merges the parts of one transaction on purpose — a sponsored payout arrives as two
 * events and has to read as one row. So a transaction the resume re-delivers, appended to a fold that
 * already holds it, is summed into the row that is already there: seen on device as a −1,000 NIGHT row
 * becoming −2,000 NIGHT after a reconnect, with the balance still correct because the UTxO map is keyed
 * and idempotent. Overlaying by transaction id *replaces* instead, which also repairs the case where
 * the socket died between two parts of one transaction — the replay re-folds it whole.
 */
/**
 * The feed's activity, one row per transaction.
 *
 * ⚠️ **`mergeActivityByTransaction` is what makes it one row.** The fold emits a row per *event*, and
 * a self-send is two events — our inputs spent, our outputs received — carrying the same hash. Left
 * unmerged they render as two identical rows, and React warns about the duplicate key because that is
 * exactly what it is. Merging also gets the amount right: each event carries only its own half, so
 * keeping the first would under-report what moved.
 *
 * This call was missing. The function, its rules and its tests were all written; nothing called it.
 */
const mergedActivity = (
  state: UnshieldedFoldState,
  cached: UnshieldedCache | undefined,
  carried: readonly MidnightActivity[],
): readonly MidnightActivity[] =>
  mergeActivityByTransaction(overlay(overlay([...foldedActivity(state)].reverse(), carried), cached?.activity ?? []))

const project = (
  state: UnshieldedFoldState,
  address: string,
  cached: UnshieldedCache | undefined,
  carried: readonly MidnightActivity[],
  spendable: readonly UnshieldedUtxo[],
): UnshieldedLive => ({
  utxos: state.utxos,
  spendable,
  activity: mergedActivity(state, cached, carried),
  address,
  caughtUp: foldIsCaughtUp(state),
})

const toCache = (
  live: UnshieldedLive,
  state: UnshieldedFoldState,
  cached: UnshieldedCache | undefined,
): UnshieldedCache => ({
  utxos: live.utxos,
  activity: live.activity,
  // Keep the cursor we resumed from when the indexer has named no higher one: moving it backwards
  // replays history already folded, moving it forward on no evidence skips history.
  transactionId: state.highestTransactionId ?? cached?.transactionId ?? 0,
  address: live.address,
})

/** `confirmed − locked`, read through the same rule every selection site uses. */
const spendableFrom = (
  params: {readonly groupId: string; readonly accountIndex: number},
  state: UnshieldedFoldState,
): Effect.Effect<readonly UnshieldedUtxo[]> =>
  spendableUnshielded(params.groupId, params.accountIndex, [...state.utxos.values()])

/**
 * Start the feed for one wallet, if it is not already running.
 *
 * ⚠️ **The durable write is deliberately not per frame.** A first replay is dozens of transactions, and
 * writing the whole blob on each would be dozens of serialisations of a growing value. The cache is
 * written once the replay is caught up, and then on each live frame after that — which is the rate real
 * transactions arrive at, not the rate a replay does.
 *
 * The fiber is a daemon: it belongs to the wallet, not to whichever effect happened to start it.
 * `Effect.fork` would make it a child of that caller and interrupt it the moment the caller returned.
 */
export const startUnshieldedFeed = (params: {
  readonly groupId: string
  readonly accountIndex: number
  readonly address: string
  readonly network: string
  /** Test seam, as on `syncUnshielded`: a scripted socket in place of the platform one. */
  readonly socketFactory?: SocketFactory
}): Effect.Effect<void, UnshieldedSyncError> =>
  Effect.gen(function* () {
    const key = feedKey(params.groupId, params.accountIndex, params.network)
    // Counted before the early return: a second consumer of a running feed must still be counted, or
    // the first one leaving would take it down under them.
    readers.set(key, (readers.get(key) ?? 0) + 1)
    if (fibers.has(key) || starting.has(key)) return
    starting.add(key)

    const httpUrl = midnightIndexerUrlFor(params.network)
    if (httpUrl === null) {
      // Undo both: this caller never got a feed, so its later `stop` must not decrement a reader it
      // never had — that would take the feed down under whoever does have one.
      readers.set(key, (readers.get(key) ?? 1) - 1)
      starting.delete(key)
      // Not a failure of the feed so much as of the build's configuration, and the caller has to be
      // able to tell those apart — the same distinction `UnshieldedSyncError` draws for the one-shot.
      return yield* new UnshieldedSyncError({
        cause: 'not-configured',
        reason: `no indexer configured for network ${params.network}`,
      })
    }

    const cached = yield* loadUnshieldedCache(params.groupId, params.accountIndex).pipe(
      Effect.catchTag('UnshieldedStoreError', (error) =>
        Effect.sync(() => {
          logger.warn('the unshielded cache could not be read; the feed replays from zero', {
            origin: ORIGIN,
            groupId: params.groupId,
            error: error.reason,
          })
          return undefined
        }),
      ),
    )
    // A cache belonging to another address is not a resume base — it is another wallet's history.
    const base = cached !== undefined && cached.address === params.address ? cached : undefined

    let state = emptyFold(base === undefined ? undefined : {utxos: base.utxos, transactionId: base.transactionId})
    /** What earlier connections of this feed folded, merged and newest-first. See {@link mergedActivity}. */
    let carried: readonly MidnightActivity[] = []
    let wroteOnce = false
    const selfRef: {fiber: Fiber.RuntimeFiber<void, never> | undefined} = {fiber: undefined}

    let attempt = 0

    // ⚠️ **`state.lastSeenId`, read at open time — not the cursor this feed started from.** A reconnect
    // that resubscribed from `base` would replay the whole session again on every drop. Resuming from
    // `state.highestTransactionId` instead — the field `toCache` writes — would be worse and quieter: it
    // is the id the indexer *named*, not the one this fold reached, so a socket that died mid-replay
    // would skip everything between the two. `lastSeenId` is the highest id actually folded, and
    // `emptyFold` seeds it from `base`, so the first attempt subscribes exactly where it used to.
    const openFrames = () =>
      subscriptionStream<{readonly unshieldedTransactions?: UnshieldedFrame | null}>({
        url: indexerWsUrl(httpUrl),
        query: UNSHIELDED_SUBSCRIPTION,
        variables: {address: params.address, transactionId: state.lastSeenId},
        ...(params.socketFactory === undefined ? {} : {socketFactory: params.socketFactory}),
      })

    const onFrame = (payload: {readonly unshieldedTransactions?: UnshieldedFrame | null}) =>
      Effect.gen(function* () {
        const frame = payload.unshieldedTransactions
        if (frame === null || frame === undefined) return
        // Before the heartbeat gate below: a heartbeat is not *news*, but it is proof the socket is
        // alive, which is the whole reason it is worth receiving.
        lastHeard.set(key, Date.now())
        // Any frame at all proves this socket worked, which is what makes the backoff per-outage
        // rather than per-feed-lifetime.
        attempt = 0
        const applied = state.applied
        state = foldUnshieldedFrame(state, frame, params.address)

        // ⚠️ **The indexer re-sends the same progress frame every 30 seconds, for ever.** Measured
        // against preprod: a caught-up address gets `PROGRESS highest=<its own last tx>` at +0.3s,
        // +30.3s, +60.3s… The one-shot never saw this because it closed at catch-up; the feed is the
        // first thing to stay open. Treating a heartbeat as an event cost a full JSON serialise of the
        // UTxO set *and* the whole activity history, a `settlePendingSends`, a lock read and a fresh
        // projection identity — so every screen re-rendered — twice a minute, per wallet, for ever.
        //
        // A progress frame does not advance `applied`, which is what separates a heartbeat from news.
        const advanced = state.applied !== applied
        if (!advanced && wroteOnce) return

        const live = project(state, params.address, base, carried, yield* spendableFrom(params, state))
        yield* publish(key, live)

        // Once at catch-up, then per transaction that actually arrives. During the replay `caughtUp`
        // is false and nothing is written, so a 38-transaction history costs one write rather than 38.
        if (live.caughtUp) {
          wroteOnce = true
          yield* saveUnshieldedCache(params.groupId, params.accountIndex, toCache(live, state, base))
          // ⚠️ The feed has to settle too, not just the one-shot. This is the only place a send's
          // outcome is ever learned, and once the feed owns the writing a send that lands on it would
          // otherwise never be recognised — its DUST spend never promoted, its inputs never unlocked.
          yield* settlePendingSends(params.groupId, params.accountIndex, live.activity, params.network)
          logger.debug('the live unshielded feed stored what it has', {
            origin: ORIGIN,
            groupId: params.groupId,
            utxos: live.utxos.size,
            applied: state.applied,
          })
        }
      })

    /**
     * One socket, consumed until it ends. Suspended so each attempt reads the cursor the fold has
     * reached rather than the one this closure was built with.
     */
    const consumeOneSocket = Effect.suspend(() => Stream.runForEach(openFrames(), onFrame))

    /**
     * Reopen the socket for as long as anyone still wants this feed.
     *
     * ⚠️ **`Effect.exit` and not `Effect.retry`, because a lost feed is usually a *success*.**
     * `runSubscription` resolves rather than rejects when the server closes a subscription that already
     * delivered payloads (`graphql-ws.ts`, `onClose` with `payloads > 0`) — which is exactly the case
     * this loop exists for. A `retry` schedule only fires on failure and would sit for ever on the
     * common one, which is how a screen came to sit still with nothing logged.
     *
     * ⚠️ **There is deliberately no interrupt check here.** Interruption passes straight *through*
     * `Effect.exit` — measured, not assumed: a loop like this one runs its body exactly once and then
     * dies, and `Cause.isInterruptedOnly` never sees the cause. So `stopUnshieldedFeed`'s
     * `Fiber.interrupt` ends this wherever it is, in the stream or in the backoff, and a guard testing
     * for it would be dead code that looked load-bearing.
     */
    const run = Effect.gen(function* () {
      while (true) {
        const outcome = yield* Effect.exit(consumeOneSocket)
        // Close this connection's activity into the carried layer before the next one re-delivers any
        // of it. Everything else about the fold — the UTxO map, the cursor, the catch-up target —
        // carries on, because the next socket resumes rather than restarts.
        carried = overlay([...foldedActivity(state)].reverse(), carried)
        state = {...state, activity: []}
        const delayMs = reconnectDelayMs(attempt)
        attempt += 1
        // Never silent: a feed that stops is indistinguishable from a chain that went quiet. The
        // projection is left published as it was — stale, not wrong — so a screen keeps its figures
        // through the gap instead of blanking.
        logger.warn('the unshielded feed lost its socket; reopening', {
          origin: ORIGIN,
          groupId: params.groupId,
          network: params.network,
          attempt,
          delayMs,
          resumingFrom: state.lastSeenId,
          cause: endedBecause(outcome),
        })
        yield* Effect.sleep(`${delayMs} millis`)
      }
    }).pipe(
      // ⚠️ **`ensuring`, not a failure handler.** The loop above only ever ends by interruption, and a
      // `catchAllCause` does not see that. Before the loop existed the same trap applied to a stream
      // that ended *cleanly*: `fibers` kept a dead entry, so `feedOwns` stayed true for ever, the
      // one-shot kept deferring to a feed that was gone and the scheduled tick kept skipping — while
      // the lock listener leaked and a later restart stacked a second one.
      Effect.ensuring(
        Effect.sync(() => {
          // Only if this fiber is still the registered one. A `stopUnshieldedFeed` that already
          // replaced or removed it must not have its successor torn down by this.
          if (fibers.get(key) === selfRef.fiber) {
            fibers.delete(key)
            lastHeard.delete(key)
            dropLockListener(key)
          }
        }),
      ),
    )

    // ⚠️ **The locks move without the chain moving.** A submitted send locks its inputs, which changes
    // what may be spent while the UTxO set is untouched — so the feed has to re-publish without
    // re-reading anything. Listening on the locks' own topic rather than `midnight-unshielded` is what
    // keeps this from being a loop: the feed's own cache writes publish the latter.
    const unlisten = onStoreChange('midnight-unshielded-locks', () => {
      Effect.runFork(
        Effect.gen(function* () {
          if (!fibers.has(key)) return
          yield* publish(key, project(state, params.address, base, carried, yield* spendableFrom(params, state)))
        }),
      )
    })
    lockListeners.set(key, unlisten)

    // The fiber has to identify itself to its own teardown, and it does not exist until `runFork`.
    const fiber = Effect.runFork(run)
    selfRef.fiber = fiber
    fibers.set(key, fiber)
    lastHeard.set(key, Date.now())
    starting.delete(key)
    logger.info('the unshielded feed opened', {
      origin: ORIGIN,
      groupId: params.groupId,
      network: params.network,
      resumingFrom: base?.transactionId ?? 0,
    })
  })

/** Stop one feed and drop its projection, so nothing renders a wallet that is no longer being watched. */
export const stopUnshieldedFeed = (key: FeedKey): Effect.Effect<void> =>
  Effect.gen(function* () {
    const left = (readers.get(key) ?? 0) - 1
    if (left > 0) {
      readers.set(key, left)
      return
    }
    readers.delete(key)
    starting.delete(key)
    lastHeard.delete(key)
    const fiber = fibers.get(key)
    if (fiber === undefined) return
    fibers.delete(key)
    dropLockListener(key)
    yield* Fiber.interrupt(fiber)
    yield* forget(key)
    logger.debug('the unshielded feed closed', {origin: ORIGIN, key})
  })

/**
 * Stop every feed and publish nothing.
 *
 * What a lock or a profile wipe calls. `profile-wipe.ts` deletes the underlying keys directly, without
 * going through the cache modules, so anything holding a parsed copy has to be told separately — that
 * is the invariant this module has to pay for by existing.
 */
export const stopAllUnshieldedFeeds = (): Effect.Effect<void> =>
  Effect.gen(function* () {
    const running = [...fibers.values()]
    for (const key of [...lockListeners.keys()]) dropLockListener(key)
    fibers.clear()
    readers.clear()
    starting.clear()
    lastHeard.clear()
    yield* Effect.forEach(running, (fiber) => Fiber.interrupt(fiber), {discard: true})
    yield* SubscriptionRef.set(unshieldedLive, new Map())
    if (running.length > 0) logger.info('every unshielded feed was stopped', {origin: ORIGIN, feeds: running.length})
  })

/**
 * Wait for a running feed to report itself caught up, and hand back what it has.
 *
 * `undefined` when it does not get there inside `timeoutMs`, or when no feed owns the key. A caller
 * that wanted a current set has to be able to tell "the feed says this" from "the feed never answered";
 * quietly returning a partial projection as though it were complete is the failure this avoids.
 */
export const awaitFeedCaughtUp = (key: FeedKey, timeoutMs = 30_000): Effect.Effect<UnshieldedLive | undefined> =>
  unshieldedLive.changes.pipe(
    Stream.map((all) => all.get(key)),
    Stream.filter((live): live is UnshieldedLive => live?.caughtUp === true),
    Stream.runHead,
    Effect.map(Option.getOrUndefined),
    Effect.timeoutTo({
      duration: `${timeoutMs} millis`,
      onSuccess: (live) => live,
      onTimeout: () => undefined,
    }),
  )
