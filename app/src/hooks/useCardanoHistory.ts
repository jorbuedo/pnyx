/**
 * Load + cache Cardano transaction history for the active wallet as
 * `ReviewedTransaction`s. The by-hash cache lets the tx-detail screen render
 * a selected item (router params can't carry the IR) without a reload.
 *
 * @module
 */

import type {ReviewedTransaction} from '@pnyx/tx-review'
import {Effect} from 'effect'
import {useCallback, useEffect, useRef, useState} from 'react'
import {logger} from '../logger'
import {useWalletList} from '../providers'
import {
  clearPendingActivity,
  type HistorySyncOptions,
  loadCardanoHistory,
  onCardanoNetworkChange,
  onPendingActivityChange,
  pendingActivityFor,
  syncCardanoHistory,
} from '../services/cardano'
import {useCardanoRail} from './useCardanoRail'
import {isStaleScope, rowsForScope, type WalletScoped, walletScopeKey, writeScoped} from './wallet-scope'

const cache = new Map<string, ReviewedTransaction>()

/** Stable identity, so "nothing painted for this wallet" does not re-render every consumer. */
const EMPTY_ITEMS: readonly ReviewedTransaction[] = []

// Keyed by tx hash alone — drop it when the rail moves so a mainnet tx can't
// answer a lookup made on a testnet.
onCardanoNetworkChange(() => {
  cache.clear()
  clearPendingActivity()
})

/** The cached reviewed tx for a hash (populated by the history load). */
export const getCachedHistoryTx = (hash: string): ReviewedTransaction | undefined => cache.get(hash)

/** Cache reviewed txs by hash so the tx-detail screen can render them by hash. */
export const primeHistoryCache = (txs: readonly ReviewedTransaction[]): void => {
  for (const tx of txs) if (tx.hash !== undefined) cache.set(tx.hash, tx)
}

/** Re-read interval (ms) while a long first backfill is running, so rows stream in. */
const POLL_MS = 1500

/**
 * How many budgeted walker runs one mount will chain before handing control back.
 *
 * ⚠️ **A bound, not a target.** The walk is resumable and persists per window, so stopping
 * early costs only time — but an unbounded loop on a wallet whose descent never converges
 * would hold a fetch open for the life of the screen. 30 passes at the walker's 20 s budget
 * covers the deepest history measured here (6.2M blocks) with room to spare; past that the
 * remainder waits for the next refresh, and says so.
 */
const MAX_BACKFILL_PASSES = 30

export type CardanoHistoryState = {
  /**
   * Rows for the *currently selected* wallet and network.
   *
   * ⚠️ Empty — never the previous wallet's — from the instant the selection changes. Held as
   * `WalletScoped` for the reason `wallet-scope` documents: the reads are asynchronous and the
   * effect that replaces them lands later, so plain state goes on rendering one wallet's
   * transactions under another's name. The portfolio blanked on a switch and this did not, which
   * is how one screen came to say two different things about whose data it was showing.
   */
  readonly items: readonly ReviewedTransaction[]
  readonly loading: boolean
  /** True while a sync/read is in flight, whoever started it. Drives the progress line. */
  readonly busy: boolean
  readonly error: string | null
  readonly unavailable: boolean
  readonly refresh: () => void
  /** Grow the rendered window by one page (reads further into the stored history). */
  readonly loadMore: () => void
  /** The last read filled the window — more stored rows likely remain. */
  readonly hasMore: boolean
}

/**
 * `pageSize` rows are read per page; `loadMore` grows the window a page at a
 * time (a pure store read — the backfill is not re-run). The home widget passes
 * a small size and ignores load-more; the Activity screen pages through all.
 */
export const useCardanoHistory = (pageSize = 25, options: HistorySyncOptions = {}): CardanoHistoryState => {
  // Read once: an options object literal at the call site is a new value every render, and this
  // feeds the sync effect.
  const maxWindows = options.maxWindows
  const {rail, loading: railLoading, unavailable} = useCardanoRail()
  const {selectedWalletGroup, selectedAccountIndex} = useWalletList()
  // Network belongs in the key as much as the wallet does: the same account on preprod and on
  // mainnet has entirely different history, and the rail carries which one it speaks to.
  const scopeKey = walletScopeKey(
    selectedWalletGroup?.groupId ?? null,
    selectedAccountIndex,
    rail?.config.networkId ?? 'none',
  )
  const [painted, setPainted] = useState<WalletScoped<ReviewedTransaction>>({key: scopeKey, rows: EMPTY_ITEMS})
  const items = rowsForScope(painted, scopeKey, EMPTY_ITEMS)
  const setItems = useCallback(
    (next: readonly ReviewedTransaction[]) => {
      setPainted((prev) => writeScoped(prev, scopeKey, next, EMPTY_ITEMS))
    },
    [scopeKey],
  )
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [nonce, setNonce] = useState(0)
  const [readLimit, setReadLimit] = useState(pageSize)
  const readLimitRef = useRef(readLimit)
  readLimitRef.current = readLimit

  const refresh = useCallback(() => {
    setReadLimit(pageSize)
    setNonce((n) => n + 1)
  }, [pageSize])
  const loadMore = useCallback(() => setReadLimit((n) => n + pageSize), [pageSize])

  // Store read only — population is owned by syncCardanoHistory. Reads the
  // current window and caches each reviewed row by hash for the detail screen.
  const readPage = useCallback(() => {
    if (rail === null) return Promise.resolve()
    const limit = readLimitRef.current
    return Effect.runPromise(
      loadCardanoHistory(rail, {limit}).pipe(
        Effect.catchAll((e) => {
          logger.warn('Failed to read the history page; the list stays as it was', {
            origin: 'useCardanoHistory',
            limit,
            error: String(e),
          })
          return Effect.succeed([] as readonly ReviewedTransaction[])
        }),
      ),
    ).then((rows) => {
      for (const tx of rows) if (tx.hash !== undefined) cache.set(tx.hash, tx)
      // Overlay transactions we submitted but the indexer has not returned yet —
      // otherwise a just-sent transaction is invisible until it lands. An entry
      // whose hash is already in `rows` is dropped by `pendingActivityFor`, so
      // the row never appears twice.
      const storedHashes = new Set(rows.flatMap((tx) => (tx.hash === undefined ? [] : [tx.hash])))
      const pending = pendingActivityFor(rail, storedHashes)
      for (const p of pending) cache.set(p.hash, p.reviewed)
      setItems([...pending.map((p) => p.reviewed), ...rows])
      setHasMore(rows.length >= limit)
    })
    // `setItems` carries the scope, so a read that resolves after a wallet switch writes under the
    // wallet it was made for and is discarded rather than painted over the new one.
  }, [rail, setItems])

  // Sync + progressive read. Re-runs on rail change / manual refresh only.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `nonce` is the manual refresh trigger; readPage is stable per rail.
  useEffect(() => {
    if (rail === null) return
    let active = true
    let poll: ReturnType<typeof setInterval> | null = null
    const stopPoll = () => {
      if (poll !== null) {
        clearInterval(poll)
        poll = null
      }
    }
    const read = () => (active ? readPage() : Promise.resolve())

    setLoading(true)
    setError(null)
    void read()
    poll = setInterval(() => void read(), POLL_MS)

    void Effect.runPromise(
      Effect.gen(function* () {
        yield* rail.sync.pipe(
          Effect.catchAll((e) => {
            logger.warn('Rail sync failed before the history walk', {
              origin: 'useCardanoHistory',
              error: String(e),
            })
            return Effect.void
          }),
        )
        // ⚠️ **Resume the descent instead of waiting to be asked.** One run stops at the
        // walker's time budget with its progress recorded; before this loop nothing
        // continued it, so history advanced a few windows per rail change or manual
        // refresh. Measured on a mainnet import whose first transaction sits 6.2M blocks
        // under the tip: the list filled a slice at a time and only when the user
        // interacted with it.
        //
        // Bounded by `active` — unmount stops it — and by the pass cap, so a wallet whose
        // floor probe never resolves cannot spin here for ever. Each pass paints, because
        // the poll below is still reading pages while this runs.
        for (let pass = 0; pass < MAX_BACKFILL_PASSES; pass++) {
          if (!active) return
          const outcome = yield* syncCardanoHistory(rail, maxWindows === undefined ? {} : {maxWindows}).pipe(
            Effect.catchAll((e) => {
              // ⚠️ `reason`, not `String(e)`. A `Data.TaggedError` stringifies to its TAG alone, so
              // this read `CardanoHistoryError` and nothing else — a report of a dead history walk
              // that named neither the refusal nor the request. It cost a mainnet bug report.
              logger.warn('History sync failed; the list keeps what is stored', {
                origin: 'useCardanoHistory',
                error: e.reason,
              })
              return Effect.succeed({backfillPaused: false, storedNew: 0})
            }),
          )
          // ⚠️ **A new transaction in the list means the balance beside it is behind.** The UTxO
          // sync is throttled to five minutes because every rail endpoint is rate-limited, and a
          // screen mount is not news — but a transaction this walk had never seen is. Without this,
          // a received payment showed as "+5 ADA" above a wallet still reading 0 for up to the rest
          // of the window: one wallet, two answers. Spent only on evidence, so an idle poll still
          // costs nothing.
          if (outcome.storedNew > 0) {
            logger.info('history stored transactions the balance has not seen; syncing the rail now', {
              origin: 'useCardanoHistory',
              storedNew: outcome.storedNew,
            })
            yield* rail.invalidateSyncThrottle
            yield* rail.sync.pipe(
              Effect.catchAll((e) => {
                logger.warn('the rail sync after new history failed; the balance catches up on the next one', {
                  origin: 'useCardanoHistory',
                  error: String(e),
                })
                return Effect.void
              }),
            )
          }
          // ⚠️ **Stop loading after the first pass, not after the last.** The descent can
          // legitimately run for minutes; holding the spinner for all of it would trade a
          // list that filled on a poke for one that never arrives. The poll above keeps
          // reading pages, so later passes paint as they land.
          if (pass === 0) {
            yield* Effect.promise(() => read())
            yield* Effect.sync(() => {
              if (active) setLoading(false)
            })
          }
          if (!outcome.backfillPaused) return
          if (pass === MAX_BACKFILL_PASSES - 1) {
            // Never silent: a history that stops short looks identical to one that is
            // complete, and the user's only clue was that scrolling found nothing older.
            logger.warn('History backfill still incomplete after the pass cap; it resumes on the next refresh', {
              origin: 'useCardanoHistory',
              passes: MAX_BACKFILL_PASSES,
            })
          }
        }
      }),
    )
      .then(async () => {
        stopPoll()
        await read()
        if (active) setLoading(false)
      })
      .catch((e: unknown) => {
        stopPoll()
        if (!active) return
        setError(e instanceof Error ? e.message : String(e))
        setLoading(false)
      })

    return () => {
      active = false
      stopPoll()
    }
  }, [rail, nonce, maxWindows])

  // Grow the window (load-more) — a plain re-read at the larger limit, no sync.
  // biome-ignore lint/correctness/useExhaustiveDependencies: readLimit is the trigger; readPage reads it via ref.
  useEffect(() => {
    if (rail === null) return
    void readPage()
  }, [rail, readLimit, readPage])

  // A transaction submitted while this list is on screen. The poll above stops as
  // soon as the initial sync resolves, so without this the row only showed up
  // where the hook happened to re-run — the Activity screen opened after a submit
  // had it, the already-mounted home widget never did.
  useEffect(() => {
    if (rail === null) return
    return onPendingActivityChange(() => {
      void readPage()
    })
  }, [rail, readPage])

  // ⚠️ **A wallet with no Cardano rail must still settle.** Every read above is gated on
  // `rail !== null`, so a wallet that will never have one — no Cardano address, no configured
  // endpoint — left the scope stamped with the previous wallet's key and `isLoading` true for ever.
  // On the wallets home that rendered activity skeletons that never resolved, on a wallet whose
  // Midnight transactions were loaded and correct the whole time. Settling with an empty set is the
  // truth for that wallet: there is no Cardano history, rather than some not yet read.
  useEffect(() => {
    if (rail !== null || railLoading || !unavailable) return
    setItems(EMPTY_ITEMS)
  }, [rail, railLoading, unavailable, setItems])

  // Nothing has been read for *this* wallet yet, however settled the previous one's read was —
  // the same rule the portfolio applies, so the two widgets invalidate together.
  const isLoading = loading || railLoading || isStaleScope(painted, scopeKey)
  return {items, loading: isLoading, busy: isLoading, error, unavailable, refresh, loadMore, hasMore}
}
