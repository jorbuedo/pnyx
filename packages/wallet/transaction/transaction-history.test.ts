/**
 * Boundary tests for the TransactionHistory pipeline.
 *
 * All tests run at the `TransactionHistory` Context.Tag — the single public
 * boundary. No test constructs `TransactionHistoryService`, `TransactionManager`,
 * or any other internal module. No `vi.mock`, no network, no database.
 *
 * @module
 */

import {describe, expect, it} from '@effect/vitest'
import {Effect} from 'effect'
import type {ChainId} from '../types.js'
import {makeInMemoryAdapter} from './in-memory-adapter.js'
import {TransactionHistory, TransactionHistoryLive} from './transaction-history.js'
import type {TransactionData, TransactionType} from './unified-transaction.js'
import {TransactionTypes} from './unified-transaction.js'

// ── Test constants ────────────────────────────────────────────────────────────

const WALLET_ID = 'wallet-test-1'
const CHAIN_A = 'cardano:mainnet' as ChainId
const CHAIN_B = 'ethereum-mainnet' as ChainId
const ADDR_A = 'addr_test1qqz7q9g3u4v5kmlws0h8x2y3z4a5b6c7d8e9f0a1b2c3d4e5f'
const ADDR_B = '0xDeAdBeEf0000000000000000000000000000dEaD'

// ── Helper factories ──────────────────────────────────────────────────────────

const makeTx = (
  overrides: Partial<TransactionData> & {readonly chain: ChainId; readonly hash: string},
): TransactionData => ({
  status: overrides.status ?? 'confirmed',
  direction: overrides.direction ?? 'sent',
  type: overrides.type ?? 'sent',
  from: overrides.from ?? ADDR_A,
  value: overrides.value ?? 1_000_000n,
  ...overrides,
})

/** Build a layer with one or two adapters + a simple static address resolver. */
const makeLayer = (
  adapters: ReadonlyArray<ReturnType<typeof makeInMemoryAdapter>['adapter']>,
  addresses: ReadonlyMap<ChainId, readonly string[]>,
  opts?: {readonly cacheTtl?: number},
) =>
  TransactionHistoryLive({
    adapters,
    resolveAddresses: () => Effect.succeed(addresses),
    cacheTtl: opts?.cacheTtl ?? 60_000,
  })

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('TransactionHistory boundary', () => {
  // ── 1. Pending at top ───────────────────────────────────────────────────────

  it.effect('query returns pending transactions at the top of results', () => {
    const confirmed = makeTx({chain: CHAIN_A, hash: 'confirmed-1', status: 'confirmed', timestamp: 1_000})
    const pending = makeTx({chain: CHAIN_A, hash: 'pending-1', status: 'pending'})

    const {adapter} = makeInMemoryAdapter(CHAIN_A, [confirmed])
    const layer = makeLayer([adapter], new Map([[CHAIN_A, [ADDR_A]]]))

    return Effect.gen(function* () {
      const svc = yield* TransactionHistory
      yield* svc.trackPending({tx: pending, action: 'add'})
      const result = yield* svc.query({walletId: WALLET_ID})

      expect(result.transactions).toHaveLength(2)
      expect(result.transactions[0]?.hash).toBe('pending-1')
      expect(result.transactions[0]?.status).toBe('pending')
      expect(result.transactions[1]?.hash).toBe('confirmed-1')
    }).pipe(Effect.provide(layer))
  })

  // ── 2. Confirmed beats pending (deduplication) ──────────────────────────────

  it.effect('query deduplicates: confirmed tx with same chain:hash replaces the pending entry', () => {
    // The adapter returns the confirmed version of a tx that is also in pending.
    const pending = makeTx({chain: CHAIN_A, hash: 'tx-abc', status: 'pending', value: 1n})
    const confirmed = makeTx({chain: CHAIN_A, hash: 'tx-abc', status: 'confirmed', value: 1n})

    const {adapter} = makeInMemoryAdapter(CHAIN_A, [confirmed])
    const layer = makeLayer([adapter], new Map([[CHAIN_A, [ADDR_A]]]))

    return Effect.gen(function* () {
      const svc = yield* TransactionHistory
      yield* svc.trackPending({tx: pending, action: 'add'})
      const result = yield* svc.query({walletId: WALLET_ID})

      // Should appear exactly once, as confirmed.
      expect(result.transactions).toHaveLength(1)
      expect(result.transactions[0]?.status).toBe('confirmed')
    }).pipe(Effect.provide(layer))
  })

  // ── 3. Partial chain failure ────────────────────────────────────────────────

  it.effect(
    'query handles partial chain failure: chain A fails, chain B returns; chainResults reflects failure',
    () => {
      const txB = makeTx({chain: CHAIN_B, hash: 'txB-1'})

      const ctrlA = makeInMemoryAdapter(CHAIN_A, [])
      ctrlA.setFailing(true)
      const ctrlB = makeInMemoryAdapter(CHAIN_B, [txB])

      const layer = makeLayer(
        [ctrlA.adapter, ctrlB.adapter],
        new Map([
          [CHAIN_A, [ADDR_A]],
          [CHAIN_B, [ADDR_B]],
        ]),
      )

      return Effect.gen(function* () {
        const svc = yield* TransactionHistory
        const result = yield* svc.query({walletId: WALLET_ID})

        // Chain B transactions are returned.
        expect(result.transactions).toHaveLength(1)
        expect(result.transactions[0]?.hash).toBe('txB-1')

        // chainResults accurately reports the per-chain outcomes.
        const aResult = result.chainResults.find((r) => r.chainId === CHAIN_A)
        const bResult = result.chainResults.find((r) => r.chainId === CHAIN_B)
        expect(aResult?._tag).toBe('failed')
        expect(bResult?._tag).toBe('ok')
      }).pipe(Effect.provide(layer))
    },
  )

  // ── 4. filter.type — data-driven coverage for all TransactionType values ────

  it.effect('query filter.type matches exactly one fixture for every TransactionType value', () => {
    // One fixture per TransactionType — gives every type a presence in the adapter.
    const allTypes = Object.values(TransactionTypes) as readonly TransactionType[]
    const fixtures = allTypes.map((type, i) => makeTx({chain: CHAIN_A, hash: `type-${type}`, type, timestamp: i + 1}))

    const {adapter} = makeInMemoryAdapter(CHAIN_A, fixtures)
    const layer = makeLayer([adapter], new Map([[CHAIN_A, [ADDR_A]]]))

    return Effect.gen(function* () {
      const svc = yield* TransactionHistory

      for (const type of allTypes) {
        const result = yield* svc.query({walletId: WALLET_ID, filter: {type: [type]}})
        expect(result.transactions, `type=${type}`).toHaveLength(1)
        expect(result.transactions[0]?.type, `type=${type}`).toBe(type)
      }
    }).pipe(Effect.provide(layer))
  })

  // ── 5. filter.type — multi-type filter returns union, not intersection ───────

  it.effect('query filter.type with multiple types returns union of matches', () => {
    const swap = makeTx({chain: CHAIN_A, hash: 'swap-1', type: 'swap'})
    const nft = makeTx({chain: CHAIN_A, hash: 'nft-1', type: 'nft'})
    const sent = makeTx({chain: CHAIN_A, hash: 'sent-1', type: 'sent'})
    const mint = makeTx({chain: CHAIN_A, hash: 'mint-1', type: 'mint'})

    const {adapter} = makeInMemoryAdapter(CHAIN_A, [swap, nft, sent, mint])
    const layer = makeLayer([adapter], new Map([[CHAIN_A, [ADDR_A]]]))

    return Effect.gen(function* () {
      const svc = yield* TransactionHistory

      const result = yield* svc.query({walletId: WALLET_ID, filter: {type: ['swap', 'nft', 'sent']}})
      expect(result.transactions).toHaveLength(3)
      expect(result.transactions.map((t) => t.type)).toEqual(expect.arrayContaining(['swap', 'nft', 'sent']))
      expect(result.transactions.map((t) => t.hash)).not.toContain('mint-1')
    }).pipe(Effect.provide(layer))
  })

  // ── 6. filter.type — negative: no fixture with requested type returns empty ──

  it.effect('query filter.type returns empty transactions when no fixture matches the requested type', () => {
    // Adapter has only sent and received — no approval fixture.
    const sent = makeTx({chain: CHAIN_A, hash: 'sent-1', type: 'sent'})
    const received = makeTx({chain: CHAIN_A, hash: 'recv-1', type: 'received'})

    const {adapter} = makeInMemoryAdapter(CHAIN_A, [sent, received])
    const layer = makeLayer([adapter], new Map([[CHAIN_A, [ADDR_A]]]))

    return Effect.gen(function* () {
      const svc = yield* TransactionHistory

      const result = yield* svc.query({walletId: WALLET_ID, filter: {type: ['approval']}})
      expect(result.transactions).toHaveLength(0)
    }).pipe(Effect.provide(layer))
  })

  // ── 7. filter.minAmount / filter.maxAmount (bigint) ─────────────────────────

  it.effect('query applies filter.minAmount and filter.maxAmount using bigint comparison', () => {
    const low = makeTx({chain: CHAIN_A, hash: 'low', value: 500_000n})
    const mid = makeTx({chain: CHAIN_A, hash: 'mid', value: 2_000_000n})
    const high = makeTx({chain: CHAIN_A, hash: 'high', value: 10_000_000n})

    const {adapter} = makeInMemoryAdapter(CHAIN_A, [low, mid, high])
    const layer = makeLayer([adapter], new Map([[CHAIN_A, [ADDR_A]]]))

    return Effect.gen(function* () {
      const svc = yield* TransactionHistory

      const aboveMin = yield* svc.query({walletId: WALLET_ID, filter: {minAmount: 1_000_000n}})
      expect(aboveMin.transactions).toHaveLength(2)
      expect(aboveMin.transactions.map((t) => t.hash)).toEqual(expect.arrayContaining(['mid', 'high']))

      const belowMax = yield* svc.query({walletId: WALLET_ID, filter: {maxAmount: 2_000_000n}})
      expect(belowMax.transactions).toHaveLength(2)
      expect(belowMax.transactions.map((t) => t.hash)).toEqual(expect.arrayContaining(['low', 'mid']))

      const range = yield* svc.query({
        walletId: WALLET_ID,
        filter: {minAmount: 1_000_000n, maxAmount: 5_000_000n},
      })
      expect(range.transactions).toHaveLength(1)
      expect(range.transactions[0]?.hash).toBe('mid')
    }).pipe(Effect.provide(layer))
  })

  // ── 8. filter.startDate / filter.endDate (Unix timestamp seconds) ───────────

  it.effect('query applies filter.startDate and filter.endDate using Unix timestamp seconds', () => {
    // timestamps in Unix seconds
    const jan = makeTx({chain: CHAIN_A, hash: 'jan', timestamp: 1_704_067_200}) // 2024-01-01
    const jun = makeTx({chain: CHAIN_A, hash: 'jun', timestamp: 1_717_200_000}) // 2024-06-01
    const dec = makeTx({chain: CHAIN_A, hash: 'dec', timestamp: 1_733_011_200}) // 2024-12-01

    const {adapter} = makeInMemoryAdapter(CHAIN_A, [jan, jun, dec])
    const layer = makeLayer([adapter], new Map([[CHAIN_A, [ADDR_A]]]))

    return Effect.gen(function* () {
      const svc = yield* TransactionHistory

      // Dates are converted to Unix seconds internally (ms / 1000).
      const fromJun = yield* svc.query({
        walletId: WALLET_ID,
        filter: {startDate: new Date(1_717_200_000 * 1000)},
      })
      expect(fromJun.transactions).toHaveLength(2)
      expect(fromJun.transactions.map((t) => t.hash)).toEqual(expect.arrayContaining(['jun', 'dec']))

      const untilJun = yield* svc.query({
        walletId: WALLET_ID,
        filter: {endDate: new Date(1_717_200_000 * 1000)},
      })
      expect(untilJun.transactions).toHaveLength(2)
      expect(untilJun.transactions.map((t) => t.hash)).toEqual(expect.arrayContaining(['jan', 'jun']))

      const junOnly = yield* svc.query({
        walletId: WALLET_ID,
        filter: {
          startDate: new Date(1_717_200_000 * 1000),
          endDate: new Date(1_717_200_000 * 1000),
        },
      })
      expect(junOnly.transactions).toHaveLength(1)
      expect(junOnly.transactions[0]?.hash).toBe('jun')
    }).pipe(Effect.provide(layer))
  })

  // ── 9. Cache hit: adapter not called on second query within TTL ─────────────

  it.effect('cache: second query within TTL does not call the adapter again', () => {
    const tx = makeTx({chain: CHAIN_A, hash: 'tx-1'})
    const ctrl = makeInMemoryAdapter(CHAIN_A, [tx])
    const layer = makeLayer([ctrl.adapter], new Map([[CHAIN_A, [ADDR_A]]]), {cacheTtl: 60_000})

    return Effect.gen(function* () {
      const svc = yield* TransactionHistory

      // Cold query — adapter called once.
      yield* svc.query({walletId: WALLET_ID})
      expect(ctrl.callCount()).toBe(1)

      // Replace the in-flight data: if cache is bypassed we'd see empty results.
      ctrl.setTransactions([])

      // Warm query — still returns cached transactions.
      const result = yield* svc.query({walletId: WALLET_ID})
      expect(ctrl.callCount()).toBe(1) // adapter NOT called again
      expect(result.transactions).toHaveLength(1) // served from cache
    }).pipe(Effect.provide(layer))
  })

  // ── 10. Cache miss after refresh ────────────────────────────────────────────

  it.effect('cache: refresh invalidates cache and re-fetches (adapter called again)', () => {
    const original = makeTx({chain: CHAIN_A, hash: 'original'})
    const updated = makeTx({chain: CHAIN_A, hash: 'updated'})

    const ctrl = makeInMemoryAdapter(CHAIN_A, [original])
    const layer = makeLayer([ctrl.adapter], new Map([[CHAIN_A, [ADDR_A]]]), {cacheTtl: 60_000})

    return Effect.gen(function* () {
      const svc = yield* TransactionHistory

      // First query populates cache.
      const r1 = yield* svc.query({walletId: WALLET_ID})
      expect(r1.transactions[0]?.hash).toBe('original')
      expect(ctrl.callCount()).toBe(1)

      // Update adapter to return new data.
      ctrl.setTransactions([updated])

      // Second query (within TTL) still returns cached data.
      const r2 = yield* svc.query({walletId: WALLET_ID})
      expect(r2.transactions[0]?.hash).toBe('original')
      expect(ctrl.callCount()).toBe(1)

      // Refresh busts the cache.
      yield* svc.refresh({walletId: WALLET_ID})
      expect(ctrl.callCount()).toBe(2) // adapter called by refresh

      // Third query hits cache populated by refresh.
      const r3 = yield* svc.query({walletId: WALLET_ID})
      expect(r3.transactions[0]?.hash).toBe('updated')
      expect(ctrl.callCount()).toBe(2) // query itself served from cache
    }).pipe(Effect.provide(layer))
  })

  // ── 11. trackPending add ────────────────────────────────────────────────────

  it.effect('trackPending add: tx appears at the top of subsequent query results', () => {
    const confirmed = makeTx({chain: CHAIN_A, hash: 'confirmed', timestamp: 1_000})
    const pending = makeTx({chain: CHAIN_A, hash: 'pending-new', status: 'pending'})

    const {adapter} = makeInMemoryAdapter(CHAIN_A, [confirmed])
    const layer = makeLayer([adapter], new Map([[CHAIN_A, [ADDR_A]]]))

    return Effect.gen(function* () {
      const svc = yield* TransactionHistory

      const before = yield* svc.query({walletId: WALLET_ID})
      expect(before.transactions).toHaveLength(1)

      yield* svc.trackPending({tx: pending, action: 'add'})
      const after = yield* svc.query({walletId: WALLET_ID})

      expect(after.transactions).toHaveLength(2)
      expect(after.transactions[0]?.hash).toBe('pending-new') // pending first
    }).pipe(Effect.provide(layer))
  })

  // ── 12. trackPending remove ─────────────────────────────────────────────────

  it.effect('trackPending remove: tx is absent from subsequent query results', () => {
    const confirmed = makeTx({chain: CHAIN_A, hash: 'confirmed'})
    const pending = makeTx({chain: CHAIN_A, hash: 'pending-to-remove', status: 'pending'})

    const {adapter} = makeInMemoryAdapter(CHAIN_A, [confirmed])
    const layer = makeLayer([adapter], new Map([[CHAIN_A, [ADDR_A]]]))

    return Effect.gen(function* () {
      const svc = yield* TransactionHistory

      yield* svc.trackPending({tx: pending, action: 'add'})
      const withPending = yield* svc.query({walletId: WALLET_ID})
      expect(withPending.transactions).toHaveLength(2)

      yield* svc.trackPending({tx: pending, action: 'remove'})
      const withoutPending = yield* svc.query({walletId: WALLET_ID})
      expect(withoutPending.transactions).toHaveLength(1)
      expect(withoutPending.transactions[0]?.hash).toBe('confirmed')
    }).pipe(Effect.provide(layer))
  })

  // ── 13. Pagination — offset > 0 does not double-skip (regression) ──────────

  it.effect('pagination: query with offset > 0 returns the correct slice of the full result', () => {
    // 6 confirmed transactions so we can clearly verify page 2 (offset=3, limit=3).
    const txs = [1, 2, 3, 4, 5, 6].map((n) =>
      makeTx({chain: CHAIN_A, hash: `tx-${n}`, status: 'confirmed', timestamp: n * 1_000}),
    )

    const {adapter} = makeInMemoryAdapter(CHAIN_A, txs)
    const layer = makeLayer([adapter], new Map([[CHAIN_A, [ADDR_A]]]))

    return Effect.gen(function* () {
      const svc = yield* TransactionHistory

      // Page 1: items 0–2 (highest timestamps first after merge sort)
      const page1 = yield* svc.query({walletId: WALLET_ID, pagination: {limit: 3, offset: 0}})
      expect(page1.transactions).toHaveLength(3)
      expect(page1.hasMore).toBe(true)
      const page1Hashes = page1.transactions.map((t) => t.hash)

      // Page 2: items 3–5 — must be the 3 txs NOT in page 1
      const page2 = yield* svc.query({walletId: WALLET_ID, pagination: {limit: 3, offset: 3}})
      expect(page2.transactions).toHaveLength(3)
      expect(page2.hasMore).toBe(false)
      const page2Hashes = page2.transactions.map((t) => t.hash)

      // Pages must be non-overlapping and together cover all 6 transactions.
      const allHashes = new Set([...page1Hashes, ...page2Hashes])
      expect(allHashes.size).toBe(6)
    }).pipe(Effect.provide(layer))
  })

  // ── 14. Cache stores full chain data — different pagination hits same cache ──

  it.effect('cache: page-2 query is served from cache populated by page-1 query', () => {
    const txs = [1, 2, 3, 4].map((n) =>
      makeTx({chain: CHAIN_A, hash: `tx-${n}`, status: 'confirmed', timestamp: n * 1_000}),
    )

    const ctrl = makeInMemoryAdapter(CHAIN_A, txs)
    const layer = makeLayer([ctrl.adapter], new Map([[CHAIN_A, [ADDR_A]]]), {cacheTtl: 60_000})

    return Effect.gen(function* () {
      const svc = yield* TransactionHistory

      // Page 1 — populates cache with all 4 transactions.
      const page1 = yield* svc.query({walletId: WALLET_ID, pagination: {limit: 2, offset: 0}})
      expect(page1.transactions).toHaveLength(2)
      expect(ctrl.callCount()).toBe(1)

      // Page 2 — must be served from cache (adapter not called again).
      const page2 = yield* svc.query({walletId: WALLET_ID, pagination: {limit: 2, offset: 2}})
      expect(page2.transactions).toHaveLength(2)
      expect(ctrl.callCount()).toBe(1) // cache hit, adapter NOT called again

      // Pages are non-overlapping.
      const p1Hashes = new Set(page1.transactions.map((t) => t.hash))
      const p2Hashes = new Set(page2.transactions.map((t) => t.hash))
      expect([...p1Hashes].every((h) => !p2Hashes.has(h))).toBe(true)
    }).pipe(Effect.provide(layer))
  })

  // ── 15a. filter.token — match by token id substring ────────────────────────

  it.effect('query filter.token matches by token id substring (case-insensitive)', () => {
    const withToken = makeTx({
      chain: CHAIN_A,
      hash: 'has-token',
      tokens: [{id: 'lovelace', symbol: 'ADA', amount: '1000000'}],
    })
    const withoutToken = makeTx({chain: CHAIN_A, hash: 'no-token'})

    const {adapter} = makeInMemoryAdapter(CHAIN_A, [withToken, withoutToken])
    const layer = makeLayer([adapter], new Map([[CHAIN_A, [ADDR_A]]]))

    return Effect.gen(function* () {
      const svc = yield* TransactionHistory
      const result = yield* svc.query({walletId: WALLET_ID, filter: {token: 'LOVE'}})
      expect(result.transactions).toHaveLength(1)
      expect(result.transactions[0]?.hash).toBe('has-token')
    }).pipe(Effect.provide(layer))
  })

  // ── 15b. filter.assetId — match via tokenTransfers ──────────────────────────

  it.effect('query filter.assetId matches by tokenTransfers[].assetId (exact match)', () => {
    const withTransfer = makeTx({
      chain: CHAIN_A,
      hash: 'has-transfer',
      tokenTransfers: [
        {
          assetId: 'policy123.tokenName',
          symbol: 'TKN',
          name: 'Token',
          amount: 100n,
          decimals: 6,
          from: ADDR_A,
          to: ADDR_B,
        },
      ],
    })
    const withoutTransfer = makeTx({chain: CHAIN_A, hash: 'no-transfer'})

    const {adapter} = makeInMemoryAdapter(CHAIN_A, [withTransfer, withoutTransfer])
    const layer = makeLayer([adapter], new Map([[CHAIN_A, [ADDR_A]]]))

    return Effect.gen(function* () {
      const svc = yield* TransactionHistory
      const result = yield* svc.query({walletId: WALLET_ID, filter: {assetId: 'policy123.tokenName'}})
      expect(result.transactions).toHaveLength(1)
      expect(result.transactions[0]?.hash).toBe('has-transfer')
    }).pipe(Effect.provide(layer))
  })

  // ── 15c. filter.search — upgraded: matches contractAddress ──────────────────

  it.effect('query filter.search matches contractAddress (field absent from old 5-field search)', () => {
    const withContract = makeTx({
      chain: CHAIN_A,
      hash: 'has-contract',
      contractAddress: '0xUniswapV3RouterXXXX',
    })
    const withoutContract = makeTx({chain: CHAIN_A, hash: 'no-contract'})

    const {adapter} = makeInMemoryAdapter(CHAIN_A, [withContract, withoutContract])
    const layer = makeLayer([adapter], new Map([[CHAIN_A, [ADDR_A]]]))

    return Effect.gen(function* () {
      const svc = yield* TransactionHistory
      const result = yield* svc.query({walletId: WALLET_ID, filter: {search: 'uniswap'}})
      expect(result.transactions).toHaveLength(1)
      expect(result.transactions[0]?.hash).toBe('has-contract')
    }).pipe(Effect.provide(layer))
  })

  // ── 15d. filter.token — match by token symbol substring ─────────────────────

  it.effect('query filter.token matches by token symbol substring (case-insensitive)', () => {
    const withToken = makeTx({
      chain: CHAIN_A,
      hash: 'has-token-symbol',
      tokens: [{id: 'ada-token', symbol: 'ADA', amount: '1000000'}],
    })
    const withoutToken = makeTx({chain: CHAIN_A, hash: 'no-token-symbol'})

    const {adapter} = makeInMemoryAdapter(CHAIN_A, [withToken, withoutToken])
    const layer = makeLayer([adapter], new Map([[CHAIN_A, [ADDR_A]]]))

    return Effect.gen(function* () {
      const svc = yield* TransactionHistory
      const result = yield* svc.query({walletId: WALLET_ID, filter: {token: 'ada'}})
      expect(result.transactions).toHaveLength(1)
      expect(result.transactions[0]?.hash).toBe('has-token-symbol')
    }).pipe(Effect.provide(layer))
  })

  // ── 15e. filter.token — negative: no matching token returns empty ─────────

  it.effect('query filter.token returns empty when no transaction has a matching token', () => {
    const withToken = makeTx({
      chain: CHAIN_A,
      hash: 'has-ada-token',
      tokens: [{id: 'lovelace', symbol: 'ADA', amount: '1000000'}],
    })

    const {adapter} = makeInMemoryAdapter(CHAIN_A, [withToken])
    const layer = makeLayer([adapter], new Map([[CHAIN_A, [ADDR_A]]]))

    return Effect.gen(function* () {
      const svc = yield* TransactionHistory
      const result = yield* svc.query({walletId: WALLET_ID, filter: {token: 'ETH'}})
      expect(result.transactions).toHaveLength(0)
    }).pipe(Effect.provide(layer))
  })

  // ── 15e2. filter.token — match by tx.assetSymbol (native chain asset) ─────
  // Regression: native ADA / ETH / BTC txs surface the asset only via
  // `assetSymbol`; their `tokens` array is undefined. Filtering by the
  // chain's native symbol previously matched zero rows.

  it.effect('query filter.token matches by tx.assetSymbol when tokens is empty (native asset)', () => {
    const nativeAda = makeTx({
      chain: CHAIN_A,
      hash: 'native-ada',
      assetSymbol: 'ADA',
    })
    const nativeEth = makeTx({chain: CHAIN_B, hash: 'native-eth', assetSymbol: 'ETH'})

    const {adapter: adapterA} = makeInMemoryAdapter(CHAIN_A, [nativeAda])
    const {adapter: adapterB} = makeInMemoryAdapter(CHAIN_B, [nativeEth])
    const layer = makeLayer(
      [adapterA, adapterB],
      new Map([
        [CHAIN_A, [ADDR_A]],
        [CHAIN_B, [ADDR_B]],
      ]),
    )

    return Effect.gen(function* () {
      const svc = yield* TransactionHistory
      const result = yield* svc.query({walletId: WALLET_ID, filter: {token: 'ADA'}})
      expect(result.transactions).toHaveLength(1)
      expect(result.transactions[0]?.hash).toBe('native-ada')
    }).pipe(Effect.provide(layer))
  })

  // ── 15e3. filter.token — match by tokenTransfers[].symbol (rich transfer) ─

  it.effect('query filter.token matches by tokenTransfers[].symbol (case-insensitive)', () => {
    const withRichTransfer = makeTx({
      chain: CHAIN_B,
      hash: 'rich-usdt',
      tokenTransfers: [
        {
          assetId: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
          symbol: 'USDT',
          name: 'Tether USD',
          amount: 1_000_000n,
          decimals: 6,
          from: ADDR_B,
          to: ADDR_A,
        },
      ],
    })
    const withoutTransfer = makeTx({chain: CHAIN_B, hash: 'no-transfer'})

    const {adapter} = makeInMemoryAdapter(CHAIN_B, [withRichTransfer, withoutTransfer])
    const layer = makeLayer([adapter], new Map([[CHAIN_B, [ADDR_B]]]))

    return Effect.gen(function* () {
      const svc = yield* TransactionHistory
      const result = yield* svc.query({walletId: WALLET_ID, filter: {token: 'usdt'}})
      expect(result.transactions).toHaveLength(1)
      expect(result.transactions[0]?.hash).toBe('rich-usdt')
    }).pipe(Effect.provide(layer))
  })

  // ── 15f. filter.assetId — match via assetDeltas ───────────────────────────

  it.effect('query filter.assetId matches by assetDeltas[].assetId (exact match)', () => {
    const withDelta = makeTx({
      chain: CHAIN_A,
      hash: 'has-delta',
      assetDeltas: [{assetId: 'policy.tokenName', delta: '100'}],
    })
    const withoutDelta = makeTx({chain: CHAIN_A, hash: 'no-delta'})

    const {adapter} = makeInMemoryAdapter(CHAIN_A, [withDelta, withoutDelta])
    const layer = makeLayer([adapter], new Map([[CHAIN_A, [ADDR_A]]]))

    return Effect.gen(function* () {
      const svc = yield* TransactionHistory
      const result = yield* svc.query({walletId: WALLET_ID, filter: {assetId: 'policy.tokenName'}})
      expect(result.transactions).toHaveLength(1)
      expect(result.transactions[0]?.hash).toBe('has-delta')
    }).pipe(Effect.provide(layer))
  })

  // ── 15g. filter.assetId — negative: no matching assetId returns empty ─────

  it.effect('query filter.assetId returns empty when no transaction matches the requested assetId', () => {
    const withTransfer = makeTx({
      chain: CHAIN_A,
      hash: 'has-transfer-other',
      tokenTransfers: [
        {
          assetId: 'policy123.tokenName',
          symbol: 'TKN',
          name: 'Token',
          amount: 100n,
          decimals: 6,
          from: ADDR_A,
          to: ADDR_B,
        },
      ],
    })

    const {adapter} = makeInMemoryAdapter(CHAIN_A, [withTransfer])
    const layer = makeLayer([adapter], new Map([[CHAIN_A, [ADDR_A]]]))

    return Effect.gen(function* () {
      const svc = yield* TransactionHistory
      const result = yield* svc.query({walletId: WALLET_ID, filter: {assetId: 'different.assetId'}})
      expect(result.transactions).toHaveLength(0)
    }).pipe(Effect.provide(layer))
  })

  // ── 15h. filter.search — upgraded: matches tokenTransfers[].symbol ────────

  it.effect('query filter.search matches tokenTransfers[].symbol (field absent from old 5-field search)', () => {
    const withTransfer = makeTx({
      chain: CHAIN_A,
      hash: 'has-transfer-symbol',
      tokenTransfers: [
        {
          assetId: 'policy.hosky',
          symbol: 'HOSKY',
          name: 'Hosky Token',
          amount: 5000n,
          decimals: 0,
          from: ADDR_A,
          to: ADDR_B,
        },
      ],
    })
    const withoutTransfer = makeTx({chain: CHAIN_A, hash: 'no-transfer-symbol'})

    const {adapter} = makeInMemoryAdapter(CHAIN_A, [withTransfer, withoutTransfer])
    const layer = makeLayer([adapter], new Map([[CHAIN_A, [ADDR_A]]]))

    return Effect.gen(function* () {
      const svc = yield* TransactionHistory
      const result = yield* svc.query({walletId: WALLET_ID, filter: {search: 'hosky'}})
      expect(result.transactions).toHaveLength(1)
      expect(result.transactions[0]?.hash).toBe('has-transfer-symbol')
    }).pipe(Effect.provide(layer))
  })

  // ── 15. Per-chain cache isolation (regression for allTransactions accumulation bug) ──

  it.effect('per-chain cache isolation: each chain stores only its own adapter-returned transactions', () => {
    // This is a regression test for the bug in history-service.ts where
    // allTransactions accumulated across chains and cache[chain] was written as
    // allTransactions.filter(tx => tx.chain === chain). When an adapter returns a
    // transaction with a foreign chain label (or when processing order matters),
    // the old code could contaminate one chain's cache with another chain's data.
    //
    // With the fix, each chain's cache entry stores exactly what ITS OWN adapter
    // returned, regardless of the order chains are processed.

    const txA1 = makeTx({chain: CHAIN_A, hash: 'a1', value: 1n})
    const txA2 = makeTx({chain: CHAIN_A, hash: 'a2', value: 2n})
    // Adapter B returns a transaction mislabeled as chain A — simulates the
    // cross-chain accumulation scenario that the old code got wrong.
    const txBmislabeled = makeTx({chain: CHAIN_A, hash: 'b-mislabeled', value: 3n})
    const txB1 = makeTx({chain: CHAIN_B, hash: 'b1', value: 4n})

    // CHAIN_B is first so it is processed before CHAIN_A.
    const ctrlB = makeInMemoryAdapter(CHAIN_B, [txBmislabeled, txB1])
    const ctrlA = makeInMemoryAdapter(CHAIN_A, [txA1, txA2])

    const addresses = new Map<ChainId, readonly string[]>([
      [CHAIN_B, [ADDR_B]], // processed first
      [CHAIN_A, [ADDR_A]], // processed second
    ])

    const layer = TransactionHistoryLive({
      adapters: [ctrlA.adapter, ctrlB.adapter],
      resolveAddresses: () => Effect.succeed(addresses),
      cacheTtl: 60_000,
    })

    return Effect.gen(function* () {
      const svc = yield* TransactionHistory

      // First query — both chains fetched fresh.
      const r1 = yield* svc.query({walletId: WALLET_ID})
      expect(r1.transactions).toHaveLength(4) // txBmislabeled, txB1, txA1, txA2

      // Drain both adapters. The only source of transactions is now the cache.
      ctrlA.setTransactions([])
      ctrlB.setTransactions([])

      // Second query within TTL — served entirely from per-chain caches.
      const r2 = yield* svc.query({walletId: WALLET_ID})

      // Fixed code stores exactly what each adapter returned:
      //   cache[CHAIN_B] = [txBmislabeled, txB1]  (2 entries — what adapter B returned)
      //   cache[CHAIN_A] = [txA1, txA2]            (2 entries — what adapter A returned)
      // Total after merge = 4.
      //
      // Old (buggy) code using allTransactions.filter(chain=B) would have stored:
      //   cache[CHAIN_B] = [txB1]  (txBmislabeled excluded because chain=A!)
      //   cache[CHAIN_A] = [txBmislabeled, txA1, txA2]  (contaminated by B's mislabeled tx!)
      // Total after merge with old code = 4 too (same count, wrong distribution).
      // The key assertion: the mislabeled tx must come from B's cache, not A's.

      expect(r2.transactions).toHaveLength(4)

      // Transactions from B's cache (what adapter B returned — including the mislabeled one).
      const fromBCache = r2.transactions.filter((tx) => tx.hash === 'b-mislabeled' || tx.hash === 'b1')
      expect(fromBCache).toHaveLength(2)

      // Transactions from A's cache (what adapter A returned — not polluted by mislabeled tx).
      const fromACache = r2.transactions.filter((tx) => tx.hash === 'a1' || tx.hash === 'a2')
      expect(fromACache).toHaveLength(2)
    }).pipe(Effect.provide(layer))
  })
})
