/**
 * Transaction history pipeline — port, implementation, and orchestration.
 *
 * Exports:
 * - `TransactionHistory` — Context.Tag (the only thing callers import)
 * - `TransactionHistoryLive` — Layer factory (wires adapters + address resolver)
 * - `TransactionHistoryError`, `ChainResult` — public types
 * - `TransactionAdapter` — port for chain adapter authors
 *
 * Filter utilities (`applyFilter`, `getTypeLabel`) live in `filter-pipeline.ts`.
 * The in-memory test stub (`makeInMemoryAdapter`) lives in `in-memory-adapter.ts`.
 *
 * @module
 */

import {Context, Data, Effect, Layer, type Option, Ref} from 'effect'
import type {ProviderError} from '../errors.js'
import type {ChainId} from '../types.js'
import {applyFilter} from './filter-pipeline.js'
import type {
  TransactionData,
  TransactionFilter,
  TransactionHistoryPagination,
  TransactionHistoryResponse,
} from './unified-transaction.js'

// Re-export filter utilities so existing callers keep working.
export {applyFilter, getTypeLabel} from './filter-pipeline.js'

// ── Errors ────────────────────────────────────────────────────────────────────

/**
 * Error raised by the `TransactionHistory` service when the pipeline cannot
 * fulfil a request at the service level (e.g. wallet not found, address
 * resolution failure). Per-chain failures are captured in `ChainResult` and
 * do NOT propagate to this error channel.
 */
export class TransactionHistoryError extends Data.TaggedError('TransactionHistoryError')<{
  readonly message: string
  readonly chain: Option.Option<ChainId>
  readonly cause: Option.Option<unknown>
}> {}

// ── Partial-failure reporting ─────────────────────────────────────────────────

/**
 * Per-chain outcome reported in `TransactionHistoryResponse.chainResults`.
 *
 * A failed chain does not abort the query — the remaining chains still return
 * their data. The UI uses `ChainResult` to display "X chain unavailable"
 * banners alongside results from healthy chains.
 */
export type ChainResult =
  | {readonly _tag: 'ok'; readonly chainId: ChainId}
  | {readonly _tag: 'failed'; readonly chainId: ChainId; readonly reason: string}

// ── Adapter port ──────────────────────────────────────────────────────────────

/**
 * Port that the `TransactionHistory` pipeline depends on.
 *
 * Each chain provides one implementation. The pipeline never imports
 * chain-specific code directly — it only calls this interface.
 *
 * Production adapters connect to chain APIs. The in-memory stub
 * (`makeInMemoryAdapter`, exported from `in-memory-adapter.ts`) is used in
 * tests. No screen or hook should ever import a concrete adapter — only the
 * `TransactionHistory` tag.
 */
export type TransactionAdapter = {
  /** Chain this adapter serves. */
  readonly chainId: ChainId

  /**
   * Fetch transactions for a single address.
   *
   * The adapter owns all format-mapping from chain-specific types to
   * `TransactionData`.
   */
  readonly getTransactions: (
    address: string,
    pagination?: TransactionHistoryPagination,
    filter?: TransactionFilter,
  ) => Effect.Effect<TransactionHistoryResponse, ProviderError>

  /**
   * Fetch a single transaction by hash.
   */
  readonly getTransaction: (hash: string) => Effect.Effect<TransactionData | null, ProviderError>
}

// ── Service interface ─────────────────────────────────────────────────────────

/**
 * Single entry point for all transaction history concerns.
 *
 * Address resolution, adapter dispatch, caching, pending overlay,
 * deduplication, filtering, and pagination are all internal. Callers pass a
 * `walletId` and receive a sorted, filtered page of transactions.
 *
 * @example
 * ```ts
 * const page = yield* Effect.flatMap(TransactionHistory, h => h.query({ walletId }))
 * ```
 */
export type TransactionHistory = {
  /**
   * Read transactions for a wallet.
   *
   * Address resolution, per-chain fan-out, cache, pending overlay, merge,
   * filter, and pagination are handled internally. Per-chain failures are
   * captured in `chainResults` and do not abort the Effect.
   */
  readonly query: (params: {
    readonly walletId: string
    readonly filter?: TransactionFilter
    readonly pagination?: TransactionHistoryPagination
  }) => Effect.Effect<
    TransactionHistoryResponse & {readonly chainResults: readonly ChainResult[]},
    TransactionHistoryError
  >

  /**
   * Optimistically add or remove a pending transaction.
   *
   * The pending entry is displayed immediately by subsequent `query` calls.
   * When a `query` returns a confirmed transaction with the same `chain:hash`
   * key, the confirmed entry replaces the pending one automatically.
   */
  readonly trackPending: (params: {
    readonly tx: TransactionData
    readonly action: 'add' | 'remove'
  }) => Effect.Effect<void, never>

  /**
   * Invalidate the cache and re-fetch all chains for the wallet.
   *
   * Use after a broadcast or on pull-to-refresh. Returns per-chain outcomes
   * so the caller can surface partial failures.
   */
  readonly refresh: (params: {
    readonly walletId: string
  }) => Effect.Effect<readonly ChainResult[], TransactionHistoryError>
}

/**
 * Context.Tag for the `TransactionHistory` service.
 *
 * All screens and hooks that need transaction history depend on this tag.
 * No screen or hook should ever import `TransactionAdapter`, `registry.ts`,
 * `history-service.ts`, or `transaction-manager.ts` directly.
 */
export const TransactionHistory = Context.GenericTag<TransactionHistory>('TransactionHistory')

// ── Internal cache type ───────────────────────────────────────────────────────

type CacheEntry = {
  readonly transactions: readonly TransactionData[]
  readonly timestamp: number
}

// ── mergePendingWithConfirmed ─────────────────────────────────────────────────────────

/**
 * Merge pending and confirmed transactions.
 *
 * Pending transactions are placed at the top, sorted by timestamp descending.
 * Confirmed transactions follow, also sorted by timestamp descending.
 * Duplicate transactions (same chain + hash) are deduplicated, preferring
 * confirmed over pending.
 */
const mergePendingWithConfirmed = (
  pending: readonly TransactionData[],
  confirmed: readonly TransactionData[],
): readonly TransactionData[] => {
  const txMap = new Map<string, TransactionData>()

  for (const tx of confirmed) {
    txMap.set(`${tx.chain}:${tx.hash}`, tx)
  }

  for (const tx of pending) {
    const key = `${tx.chain}:${tx.hash}`
    if (!txMap.has(key)) txMap.set(key, tx)
  }

  return [...txMap.values()].sort((a, b) => {
    if (a.status === 'pending' && b.status !== 'pending') return -1
    if (a.status !== 'pending' && b.status === 'pending') return 1
    return (b.timestamp ?? 0) - (a.timestamp ?? 0)
  })
}

// ── TransactionHistoryLive ────────────────────────────────────────────────────

/**
 * Configuration for `TransactionHistoryLive`.
 */
export type TransactionHistoryConfig = {
  /**
   * One adapter per chain. The pipeline fan-outs only to chains present here.
   * Production adapters live in `adapters/`. Tests use `makeInMemoryAdapter`.
   */
  readonly adapters: readonly TransactionAdapter[]

  /**
   * Resolve the address map for a wallet.
   *
   * Called on every cache-miss and on `refresh`. The returned map controls
   * which chains are queried — chains without adapters are silently skipped.
   *
   * In production, wire this to `WalletManager` + `WalletDataStore`.
   * In tests, return a hard-coded `Map`.
   */
  readonly resolveAddresses: (
    walletId: string,
  ) => Effect.Effect<ReadonlyMap<ChainId, readonly string[]>, TransactionHistoryError>

  /** Per-chain cache TTL in milliseconds. Default: 60 000 (1 minute). */
  readonly cacheTtl?: number

  /** Maximum number of cache entries (LRU eviction). Default: 100. */
  readonly maxCacheSize?: number
}

/**
 * Production Layer for the `TransactionHistory` service.
 *
 * Encapsulates address resolution, per-chain fan-out, cache (TTL + LRU),
 * pending transaction overlay, deduplication, filtering, and pagination.
 *
 * @example
 * ```ts
 * // Production wiring
 * const layer = TransactionHistoryLive({
 *   adapters: [cardanoAdapter, evmAdapter, solanaAdapter],
 *   resolveAddresses: (walletId) => resolveViaWalletManager(walletId),
 * })
 *
 * // Test wiring
 * const layer = TransactionHistoryLive({
 *   adapters: [makeInMemoryAdapter('cardano:mainnet', [txA]).adapter],
 *   resolveAddresses: () => Effect.succeed(new Map([['cardano:mainnet', ['addr1']]])),
 * })
 * ```
 */
export const TransactionHistoryLive = (config: TransactionHistoryConfig): Layer.Layer<TransactionHistory> =>
  Layer.effect(
    TransactionHistory,
    Effect.gen(function* () {
      const cacheTtl = config.cacheTtl ?? 60_000
      const maxCacheSize = config.maxCacheSize ?? 100

      const cacheRef = yield* Ref.make<Map<string, CacheEntry>>(new Map())
      const pendingRef = yield* Ref.make<Map<string, TransactionData>>(new Map())

      // Build an O(1) lookup map from the adapters array.
      const adapterMap = new Map<ChainId, TransactionAdapter>()
      for (const adapter of config.adapters) {
        adapterMap.set(adapter.chainId, adapter)
      }

      const isCacheValid = (entry: CacheEntry): boolean => Date.now() - entry.timestamp < cacheTtl

      const pruneCache = (cache: Map<string, CacheEntry>): Map<string, CacheEntry> => {
        if (cache.size <= maxCacheSize) return cache
        const sorted = [...cache.entries()].sort(([, a], [, b]) => a.timestamp - b.timestamp)
        const pruned = new Map(cache)
        for (const [key] of sorted.slice(0, sorted.length - maxCacheSize)) {
          pruned.delete(key)
        }
        return pruned
      }

      const makeCacheKey = (chainId: ChainId, addresses: readonly string[]): string =>
        `${chainId}:${[...addresses].sort().join(',')}`

      /**
       * Fetch all addresses for a chain via its adapter.
       *
       * Writes ONLY the freshly-fetched transactions for this chain into the
       * cache (fixes the cross-chain accumulation bug from history-service.ts).
       * Per-address failures are collected but do not abort the other addresses.
       *
       * Neither pagination nor filter is forwarded to adapters. The pipeline
       * applies offset/limit and filter on the merged multi-chain result in `query`.
       * Forwarding filter would cause the cache to store pre-filtered results under
       * a key that excludes the filter, so a subsequent query with a different filter
       * would silently return incorrect cached data. The same reasoning that applies
       * to pagination (avoid partial pages in cache) applies equally to filter.
       */
      const fetchAndCache = (
        chainId: ChainId,
        adapter: TransactionAdapter,
        addresses: readonly string[],
      ): Effect.Effect<{readonly transactions: readonly TransactionData[]; readonly result: ChainResult}, never> =>
        Effect.gen(function* () {
          const chainTxs: TransactionData[] = []
          let failed = false
          let failureReason = ''

          for (const address of addresses) {
            const outcome = yield* adapter.getTransactions(address, undefined).pipe(
              Effect.matchEffect({
                onSuccess: (response) => Effect.succeed({ok: true as const, txs: response.transactions}),
                onFailure: (e) => Effect.succeed({ok: false as const, reason: e.message}),
              }),
            )
            if (outcome.ok) {
              chainTxs.push(...outcome.txs)
            } else {
              failed = true
              failureReason = outcome.reason
            }
          }

          const result: ChainResult = failed ? {_tag: 'failed', chainId, reason: failureReason} : {_tag: 'ok', chainId}

          if (!failed) {
            // Write ONLY this chain's freshly-fetched transactions to the cache.
            // Using a per-chain array (not allTransactions.filter) ensures isolation.
            const key = makeCacheKey(chainId, addresses)
            yield* Ref.update(cacheRef, (c) => {
              const updated = new Map(c)
              updated.set(key, {transactions: chainTxs, timestamp: Date.now()})
              return pruneCache(updated)
            })
          }

          return {transactions: chainTxs, result}
        })

      // ── query ───────────────────────────────────────────────────────────────

      /** Resolve a single chain: serve from cache or fetch via adapter. */
      const resolveChain = (
        chainId: ChainId,
        addresses: readonly string[],
        cache: Map<string, CacheEntry>,
      ): Effect.Effect<{readonly transactions: readonly TransactionData[]; readonly result: ChainResult}, never> => {
        const adapter = adapterMap.get(chainId)
        if (!adapter) return Effect.succeed({transactions: [], result: {_tag: 'ok', chainId}})

        const key = makeCacheKey(chainId, addresses)
        const cached = cache.get(key)

        if (cached && isCacheValid(cached)) {
          return Effect.succeed({transactions: cached.transactions, result: {_tag: 'ok', chainId}})
        }

        return fetchAndCache(chainId, adapter, addresses)
      }

      const query: TransactionHistory['query'] = ({walletId, filter, pagination}) =>
        Effect.gen(function* () {
          const addressMap = yield* config.resolveAddresses(walletId)

          // Snapshot the cache once so every chain sees the same baseline.
          const currentCache = yield* Ref.get(cacheRef)

          // Fan out all chains concurrently — cache hits resolve instantly,
          // cache misses fetch in parallel instead of sequentially.
          const entries = [...addressMap.entries()].filter(([cid]) => adapterMap.has(cid))
          const outcomes = yield* Effect.all(
            entries.map(([chainId, addresses]) => resolveChain(chainId, addresses, currentCache)),
            {concurrency: 'unbounded'},
          )

          const allTransactions: TransactionData[] = []
          const chainResults: ChainResult[] = []
          for (const {transactions: txs, result} of outcomes) {
            allTransactions.push(...txs)
            chainResults.push(result)
          }

          // Pending overlay: confirmed beats pending (dedup by chain:hash).
          const pendingMap = yield* Ref.get(pendingRef)
          const merged = mergePendingWithConfirmed([...pendingMap.values()], allTransactions)

          // Apply filter after merge so pending txs are also filtered.
          const filtered = applyFilter(merged, filter)

          // Offset-based pagination.
          const limit = pagination?.limit ?? 50
          const offset = pagination?.offset ?? 0
          const page = filtered.slice(offset, offset + limit)

          return {
            transactions: page,
            hasMore: offset + limit < filtered.length,
            cursor: page.length > 0 ? String(offset + limit) : undefined,
            total: filtered.length,
            chainResults,
          }
        })

      // ── trackPending ────────────────────────────────────────────────────────

      const trackPending: TransactionHistory['trackPending'] = ({tx, action}) =>
        Ref.update(pendingRef, (m) => {
          const updated = new Map(m)
          const key = `${tx.chain}:${tx.hash}`
          if (action === 'add') {
            updated.set(key, tx)
          } else {
            updated.delete(key)
          }
          return updated
        })

      // ── refresh ─────────────────────────────────────────────────────────────

      const refresh: TransactionHistory['refresh'] = ({walletId}) =>
        Effect.gen(function* () {
          const addressMap = yield* config.resolveAddresses(walletId)

          // Invalidate all cache entries for this wallet's chains.
          yield* Ref.update(cacheRef, (c) => {
            const updated = new Map(c)
            for (const [chainId, addresses] of addressMap) {
              updated.delete(makeCacheKey(chainId, addresses))
            }
            return updated
          })

          const entries = [...addressMap.entries()].filter(([cid]) => adapterMap.has(cid))
          const outcomes = yield* Effect.all(
            entries.flatMap(([chainId, addresses]) => {
              const adapter = adapterMap.get(chainId)
              if (!adapter) return []
              return [fetchAndCache(chainId, adapter, addresses)]
            }),
            {concurrency: 'unbounded'},
          )

          return outcomes.map(({result}) => result)
        })

      return {query, trackPending, refresh}
    }),
  )
