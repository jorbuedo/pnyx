/**
 * Shielded wallet sync — walk the chain, hand every confirmed transaction to the native wallet.
 *
 * **This is the private one of the two sync shapes the wallet specification describes.** The other
 * hands the indexer your *viewing key* and lets it filter: much less work for the phone, at the cost
 * of the operator learning your whole shielded history. This one asks for blocks and decides locally
 * which outputs are ours, so nothing outside the device learns what we hold. What it costs is a
 * request per block and a decryption attempt per output, which is why it takes a bounded range rather
 * than pretending a phone can scan a chain from genesis.
 *
 * Both shapes reduce to the same two native calls (`walletApplyTransaction`, and
 * `walletApplyCollapsedUpdate` for ranges we can skip), so a viewing-key source can be added beside
 * this one without changing the wallet.
 *
 * ⚠️ **A bounded walk is only correct if the tree is fast-forwarded to where it starts.** The
 * commitment tree is indexed by position, so a wallet that applies its first transaction to a blank
 * tree puts the coin at index 0 — and then proves every spend against a root no block ever held. That
 * is a wallet showing a balance it cannot move, with nothing local to explain why. {@link collapseTo}
 * is the fix, and {@link verifyRoot} is how we find out it worked.
 *
 * @module
 */

import {
  type WalletStateBytes,
  walletApplyCollapsedUpdate,
  walletApplyTransaction,
  walletMerkleRoot,
} from '@pnyx/midnight-native'
import {Data, Effect} from 'effect'

import {logger} from '../../../logger'
import {midnightIndexerUrlFor} from '../contract-state'
import {type BlocksPayload, blocksSubscription, collectBlocks} from './block-stream'
import {describeSocketError, runSubscription} from './graphql-ws'
import {applyDecision} from './shielded-apply-rule'
import {indexerWsUrl} from './unshielded-sync'

const ORIGIN = 'shielded-sync'

/**
 * The shielded walk could not proceed.
 *
 * ⚠️ `not-configured` is separated from the transport causes because it used to be indistinguishable:
 * {@link fetchTipHeight} answered `null` for both "this build has no indexer for the network" and "the
 * read failed", so a failed tip read reached the log as *"no indexer for network"* — a sentence naming
 * the wrong problem. `native` is the wallet bridge refusing a transaction, which stops the walk for a
 * reason that is neither the indexer's nor the network's.
 */
export class ShieldedSyncError extends Data.TaggedError('ShieldedSyncError')<{
  readonly cause: 'not-configured' | 'http' | 'graphql' | 'native'
  readonly reason: string
}> {}

const TIP_QUERY = `query Tip {
  block { height }
}`

/**
 * How many commitment leaves the chain held after a block, and the tree root it held.
 *
 * `zswapEndIndex` is exclusive — it is the *next free* leaf. Measured, not assumed: preprod block
 * 2,534,135 reports 21,371 and the transaction in the block after it writes its first leaf at 21,371
 * (`rust/tests/birthday_sync_places_coins_at_chain_indices.rs`).
 */
const TREE_AT_QUERY = `query TreeAt($height: Int!) {
  block(offset: {height: $height}) { height zswapEndIndex zswapMerkleTreeRoot }
}`

const COLLAPSED_UPDATE_QUERY = `query Collapse($startIndex: Int!, $endIndex: Int!) {
  zswapMerkleTreeCollapsedUpdate(startIndex: $startIndex, endIndex: $endIndex) { update }
}`

/** Epoch **milliseconds**, which is what the indexer serves — verified against preview, not assumed. */
const BLOCK_TIME_QUERY = `query BlockTime($height: Int!) {
  block(offset: {height: $height}) { height timestamp }
}`

const fromHex = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

/**
 * How many times a refused request is tried again, and how long between.
 *
 * ⚠️ **The refusal is the indexer shutting the door on this address, and it lasts about twenty
 * seconds.** Measured 2026-09-14 against preprod, after a real backfill died at 15,000 blocks with
 * *"indexer responded 403 (after 4 attempts)"*: once refused, **every** request from the same address
 * comes back 403 — a thirty-byte `{ block { height } }` included — and the door reopens on its own
 * after ~20 s. So it is not the query, and a walk cannot dodge it by asking for less; it can only wait
 * longer than the door stays shut. This schedule waits **32.6 s across six attempts**, where the
 * earlier 400/1,200/3,000 waited 4.6 s and gave up while still inside the closed window.
 *
 * ⚠️ This corrects the earlier reading of the same 403 as an *intermittent* refusal that was "neither a
 * size problem nor a simple quota". It is a quota — just one measured over a window long enough that
 * sixty back-to-back requests never reach it and a hundred-thousand-block backfill certainly does.
 *
 * ⚠️ **Distinct from the 8 KiB cap, which is also a 403 and must NOT be retried.** That one comes back
 * as nginx's HTML error page for any request over 8,192 bytes — measured at the boundary, 8,012 B
 * answering 200 and 8,512 B answering 403 — and retrying it would just fail again more slowly. Two
 * shapes behind one status, the same trap as Koios's two 429s. Every HTTP request left in this module
 * is a single small query — the tip, a collapsed update, a block's timestamp — so a 403 it meets is the
 * rate one. ⚠️ Blocks no longer come this way at all: they stream (`block-stream.ts`), which is what
 * took a backfill out of the rate limit's reach rather than merely surviving it.
 */
const RETRY_BACKOFF_MS: readonly number[] = [400, 1_200, 3_000, 8_000, 20_000]

/** Worth trying again: a transport failure, a refusal that may be transient, or the server erroring. */
const worthRetrying = (status: number): boolean => status === 403 || status === 429 || status >= 500

const query = <T>(url: string, body: string, variables: Record<string, number>): Effect.Effect<T, ShieldedSyncError> =>
  Effect.gen(function* () {
    let response: Response | undefined
    let lastFailure = 'the request was never made'
    for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt++) {
      if (attempt > 0) {
        // Indexed from the loop, so it cannot be undefined; named here so the type says so too.
        const waitMs = RETRY_BACKOFF_MS[attempt - 1] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1] ?? 1_000
        // ⚠️ Logged, not silent. A walk that pauses for seconds with nothing in the log is
        // indistinguishable from one that has hung, and that is a bug report nobody can answer.
        logger.warn('indexer request refused; retrying', {origin: ORIGIN, attempt, waitMs, reason: lastFailure})
        yield* Effect.sleep(`${waitMs} millis`)
      }
      const attempted = yield* Effect.either(
        Effect.tryPromise({
          try: () =>
            fetch(url, {
              method: 'POST',
              headers: {'Content-Type': 'application/json'},
              body: JSON.stringify({query: body, variables}),
            }),
          catch: (error) => new ShieldedSyncError({cause: 'http', reason: String(error)}),
        }),
      )
      if (attempted._tag === 'Left') {
        lastFailure = attempted.left.reason
        continue
      }
      if (attempted.right.ok) {
        response = attempted.right
        break
      }
      lastFailure = `indexer responded ${attempted.right.status}`
      // A refusal that will not change on a second attempt — a malformed query, an unknown path — stops
      // here rather than being tried three more times for the same answer.
      if (!worthRetrying(attempted.right.status)) {
        return yield* new ShieldedSyncError({cause: 'http', reason: lastFailure})
      }
    }
    if (response === undefined) {
      return yield* new ShieldedSyncError({
        cause: 'http',
        reason: `${lastFailure} (after ${RETRY_BACKOFF_MS.length + 1} attempts)`,
      })
    }
    const reply = yield* Effect.tryPromise({
      try: () => response.json() as Promise<{errors?: readonly {message: string}[]}>,
      catch: (error) => new ShieldedSyncError({cause: 'http', reason: String(error)}),
    })
    if (reply.errors !== undefined && reply.errors.length > 0) {
      return yield* new ShieldedSyncError({cause: 'graphql', reason: reply.errors.map((e) => e.message).join('; ')})
    }
    return reply as T
  })

/**
 * The chain tip. `null` means the indexer answered and named no height — never `0`, which is a height.
 *
 * ⚠️ **A failed read now fails, rather than answering `null`.** Both used to be `null`, so the caller
 * logged a broken indexer as "no indexer for network". An unconfigured network is still distinct: it
 * fails with `not-configured`, which no retry fixes.
 */
export const fetchTipHeight = (network: string | null): Effect.Effect<number | null, ShieldedSyncError> =>
  Effect.gen(function* () {
    const url = midnightIndexerUrlFor(network)
    if (url === null) {
      return yield* new ShieldedSyncError({
        cause: 'not-configured',
        reason: `no indexer configured for network ${network ?? 'unset'}`,
      })
    }
    const reply = yield* query<{data?: {block?: {height?: number} | null}}>(url, TIP_QUERY, {})
    return reply.data?.block?.height ?? null
  })

/**
 * Fast-forward `state`'s commitment tree to exactly the leaves the chain held before `fromHeight`.
 *
 * ⚠️ **Without this a bounded sync is wrong, not merely partial.** A blank tree puts the first coin
 * it meets at index 0, and the spend proofs built from it are against a root no block ever held — so
 * the wallet shows a balance it can never move, and says nothing about why. Proven both ways against
 * a real preprod coin in `rust/tests/birthday_sync_places_coins_at_chain_indices.rs`.
 *
 * A `fromHeight` of 1 needs no update: there are no leaves before the first block. The same is true
 * of a chain whose tree is still empty at that height, which the indexer reports as `zswapEndIndex`
 * 0 — and asking for the range `[0, -1]` would be a malformed query rather than an empty one.
 */
export const collapseTo = (params: {
  readonly state: WalletStateBytes
  readonly zswapRoleKey: Uint8Array
  readonly fromHeight: number
  readonly network: string | null
}): Effect.Effect<WalletStateBytes, ShieldedSyncError> =>
  Effect.gen(function* () {
    const url = midnightIndexerUrlFor(params.network)
    if (url === null) {
      return yield* new ShieldedSyncError({
        cause: 'not-configured',
        reason: `no indexer configured for network ${params.network ?? 'unset'}`,
      })
    }
    if (params.fromHeight <= 1) return params.state

    const before = yield* query<{data?: {block?: {zswapEndIndex?: number} | null}}>(url, TREE_AT_QUERY, {
      height: params.fromHeight - 1,
    })
    const firstFree = before.data?.block?.zswapEndIndex
    if (firstFree === undefined) {
      return yield* new ShieldedSyncError({
        cause: 'graphql',
        reason: `no block at height ${params.fromHeight - 1} to read the tree size from`,
      })
    }
    if (firstFree === 0) {
      logger.debug('nothing to collapse: the chain held no commitments before this height', {
        origin: ORIGIN,
        fromHeight: params.fromHeight,
      })
      return params.state
    }

    const reply = yield* query<{data?: {zswapMerkleTreeCollapsedUpdate?: {update?: string} | null}}>(
      url,
      COLLAPSED_UPDATE_QUERY,
      {startIndex: 0, endIndex: firstFree - 1},
    )
    const update = reply.data?.zswapMerkleTreeCollapsedUpdate?.update
    if (update === undefined) {
      return yield* new ShieldedSyncError({
        cause: 'graphql',
        reason: `the indexer served no collapsed update for [0, ${firstFree - 1}]`,
      })
    }

    const next = yield* Effect.tryPromise({
      try: () => walletApplyCollapsedUpdate(params.state, params.zswapRoleKey, fromHex(update)),
      catch: (error) => new ShieldedSyncError({cause: 'native', reason: String(error)}),
    })
    logger.info('commitment tree fast-forwarded to the sync start', {
      origin: ORIGIN,
      fromHeight: params.fromHeight,
      leaves: firstFree,
    })
    return next
  })

/**
 * Is this wallet's tree the chain's?
 *
 * ⚠️ **Nothing else answers that.** The collapsed update is *not* self-validating — only its framing
 * is checked, and 311 of 377 single-byte flips in a real preprod update are accepted, each producing
 * a healthy-looking tree that differs from the chain's. Two docs in this repo claimed the opposite
 * until it was measured. The root the indexer reports per block is the outside evidence.
 *
 * Failing here is right. A wallet that has silently diverged reports a balance it cannot spend, and
 * the only repair is a resync — which cannot start while the cursor says the range is done.
 */
export const verifyRoot = (params: {
  readonly state: WalletStateBytes
  readonly expected: string
  readonly height: number
}): Effect.Effect<void, ShieldedSyncError> =>
  Effect.gen(function* () {
    const actual = yield* Effect.tryPromise({
      try: () => walletMerkleRoot(params.state),
      catch: (error) => new ShieldedSyncError({cause: 'native', reason: String(error)}),
    })
    if (actual === params.expected) {
      logger.debug('tree root agrees with the chain', {origin: ORIGIN, height: params.height})
      return
    }
    return yield* new ShieldedSyncError({
      cause: 'native',
      reason:
        `the local commitment tree does not match the chain at height ${params.height}: ` +
        `expected ${params.expected}, built ${actual}`,
    })
  })

export type SyncProgress = {
  readonly height: number
  readonly transactionsApplied: number
  readonly transactionsSkipped: number
}

export type SyncResult = {
  readonly state: WalletStateBytes
  /** The last height applied, so a caller can resume from `height + 1` rather than rescan. */
  readonly height: number
  /**
   * How many blocks were actually walked. Reported because most Midnight blocks carry no
   * transactions at all, so "0 applied" is ambiguous without it — a caller cannot otherwise tell a
   * quiet range from a sync that never ran.
   */
  readonly blocksScanned: number
  readonly transactionsApplied: number
  readonly transactionsSkipped: number
}

/**
 * Apply every confirmed transaction in `[fromHeight, toHeight]` to `state`, in order.
 *
 * Order is not a preference: the commitment tree is indexed by position, so a block applied out of
 * sequence puts our coins at indices the chain assigned to other commitments, and every proof built
 * from that tree fails.
 *
 * A block the indexer cannot answer for **stops the walk** rather than being skipped. Continuing past
 * a gap would leave a tree that looks complete and proves nothing, and the caller can retry from the
 * height this returns.
 */
export const syncShieldedRange = (params: {
  readonly state: WalletStateBytes
  readonly zswapRoleKey: Uint8Array
  readonly fromHeight: number
  readonly toHeight: number
  readonly network: string | null
  /**
   * Fast-forward the tree to `fromHeight` before applying anything — true on a **first** sync, where
   * the local tree holds nothing. See {@link collapseTo} for why skipping it is a correctness bug
   * rather than a missing optimisation.
   */
  readonly collapseFirst?: boolean
  readonly onProgress?: (progress: SyncProgress) => void
}): Effect.Effect<SyncResult, ShieldedSyncError> =>
  Effect.gen(function* () {
    const url = midnightIndexerUrlFor(params.network)
    if (url === null) {
      return yield* new ShieldedSyncError({
        cause: 'not-configured',
        reason: `no indexer configured for network ${params.network ?? 'unset'}`,
      })
    }

    let state =
      params.collapseFirst === true
        ? yield* collapseTo({
            state: params.state,
            zswapRoleKey: params.zswapRoleKey,
            fromHeight: params.fromHeight,
            network: params.network,
          })
        : params.state
    let applied = 0
    let skipped = 0
    let scanned = 0
    let height = params.fromHeight - 1
    // The root the chain held at the last block we actually walked. Checked once at the end rather
    // than per block: a divergence anywhere shows up in the final root just the same, and rehashing
    // the tree every block would pay for that certainty a few hundred times over.
    let lastRoot: string | undefined

    // Where a walk's wall time actually goes. Reported because the three costs — fetching, applying and
    // checking the root — are paid in very different proportions depending on how dense the range is,
    // and a total alone cannot say which one to attack next.
    let fetchMs = 0
    let applyMs = 0
    {
      // ⚠️ **One subscription for the range, not one request per sixteen blocks.** The indexer rate
      // limits by address — ~1,158 requests in 179 s, then 403 to everything for up to two minutes —
      // and a backfill is exactly the shape that drains it. A stream spends one request. Measured
      // 2026-09-14: 23,782 blocks a minute against ~4,600 for the batched fetch.
      const fetchStarted = Date.now()
      const collector = collectBlocks(params.fromHeight, params.toHeight)
      yield* Effect.tryPromise({
        try: () =>
          runSubscription<BlocksPayload>({
            url: indexerWsUrl(url),
            query: blocksSubscription(),
            variables: {height: params.fromHeight},
            onNext: (payload) => collector.accept(payload),
          }),
        catch: (error) => new ShieldedSyncError({cause: 'http', reason: describeSocketError(error)}),
      })
      fetchMs = Date.now() - fetchStarted

      const ending = collector.end()
      if (ending?.kind === 'gap') {
        // Same rule the batched walk had for a block the indexer could not answer for: stop where we
        // are rather than apply across a hole, and let the caller retry from the height we return.
        logger.warn('sync stopped: the stream skipped a height', {
          origin: ORIGIN,
          expected: ending.expected,
          got: ending.got,
        })
      } else if (ending === undefined) {
        // The socket closed or fell silent before the range was covered. Not fatal — what was taken is
        // still in order and still applies — but it must be said, or a short walk reads as a quiet chain.
        logger.warn('the block stream ended before the range did', {
          origin: ORIGIN,
          from: params.fromHeight,
          to: params.toHeight,
          taken: collector.blocks().length,
        })
      }

      for (const block of collector.blocks()) {
        for (const tx of block.transactions ?? []) {
          const decision = applyDecision(tx.transactionResult)
          if (!decision.apply || tx.raw === undefined) {
            skipped += 1
            continue
          }
          // `tryPromise`, not `promise`: a bridge rejection must stay a failure a caller can catch, not
          // become an Effect defect that sails past every `catchAll` on the way out.
          const applyStarted = Date.now()
          state = yield* Effect.tryPromise({
            try: () => walletApplyTransaction(state, params.zswapRoleKey, fromHex(tx.raw as string), decision.segments),
            catch: (error) => new ShieldedSyncError({cause: 'native', reason: String(error)}),
          })
          applyMs += Date.now() - applyStarted
          applied += 1
        }
        height = block.height
        scanned += 1
        lastRoot = block.zswapMerkleTreeRoot
      }
      params.onProgress?.({height, transactionsApplied: applied, transactionsSkipped: skipped})
    }

    // ⚠️ **Before returning, not after persisting.** A caller that saved this state and advanced its
    // cursor past a diverged tree could never rescan the range that caused it.
    if (lastRoot !== undefined) {
      const verifyStarted = Date.now()
      yield* verifyRoot({state, expected: lastRoot, height})
      logger.debug('walk cost', {
        origin: ORIGIN,
        blocks: scanned,
        fetchMs,
        applyMs,
        verifyMs: Date.now() - verifyStarted,
      })
    } else if (scanned > 0) {
      // A walked block whose root the indexer did not name. Nothing checked this tree, and saying so
      // is the difference between "verified" and "we never looked".
      logger.warn('sync could not verify the tree: the indexer named no root', {origin: ORIGIN, height})
    }

    return {state, height, blocksScanned: scanned, transactionsApplied: applied, transactionsSkipped: skipped}
  })

/**
 * When a block was made, in epoch milliseconds. `null` for a height the indexer cannot answer for.
 *
 * Used by the birthday backfill (plan item 62(c)) to turn a wallet's creation date into a height. It
 * is a *read*, so a miss is not a failure of ours — but it stops the search that calls it rather than
 * being narrowed past, because a bound picked on no evidence produces a birthday nobody can tell is
 * wrong.
 */
export const fetchBlockTimestamp = (
  network: string | null,
  height: number,
): Effect.Effect<number | null, ShieldedSyncError> =>
  Effect.gen(function* () {
    const url = midnightIndexerUrlFor(network)
    if (url === null) {
      return yield* new ShieldedSyncError({
        cause: 'not-configured',
        reason: `no indexer configured for network ${network ?? 'unset'}`,
      })
    }
    const reply = yield* query<{data?: {block?: {timestamp?: number} | null}}>(url, BLOCK_TIME_QUERY, {height})
    return reply.data?.block?.timestamp ?? null
  })
