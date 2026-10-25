/**
 * Where a funds group's unshielded UTxO set is cached.
 *
 * ⚠️ **A cache, unlike the shielded state.** Every unshielded UTxO is on chain in the clear, so losing
 * this costs one replay of the subscription and nothing else — the opposite of `state-store.ts`, whose
 * blob can hold the only copy of a contract-minted coin. That difference is why this module may return
 * `undefined` for an unreadable blob where that one throws.
 *
 * ⚠️ **The set and its cursor live in one value on purpose.** They are written together after a sync, and
 * a half-landed write that advanced the cursor without the UTxOs it accounted for would leave a wallet
 * permanently missing coins — a resume starts *after* the transactions that created them. One key cannot
 * diverge from itself.
 *
 * Profile-scoped through `storage`, like every other wallet key: the decoy profile keeps its own.
 *
 * @module
 */

import {Data, Effect} from 'effect'

import {logger} from '../../../logger'
import {storage} from '../../../platform/storage'
import {publishStoreChange} from '../../store-change'
import {type MidnightActivity, type MidnightDirection, outcomeOf} from './midnight-activity'
import {type UnshieldedUtxo, utxoKey} from './unshielded-utxo-set'

const ORIGIN = 'midnight-unshielded-store'

/**
 * The blob could not be reached at all — storage itself failed.
 *
 * ⚠️ Distinct from an *unreadable* blob, which {@link parseUnshieldedCache} answers with `undefined`
 * because a resync fixes it. This one means the read never happened, and a caller that treats it as
 * "no cache" would resync on every attempt while never noticing storage is broken.
 */
export class UnshieldedStoreError extends Data.TaggedError('UnshieldedStoreError')<{
  readonly reason: string
}> {}

/**
 * How many transactions the cache keeps, newest first. A wallet with a long history would otherwise grow
 * this blob without bound; the activity list pages far less than this. Truncation is **logged**, because a
 * silently shortened history reads as a complete one.
 */
export const ACTIVITY_CACHE_LIMIT = 200

/** `@pnyx/midnight/unshielded/<groupId>/<accountIndex>` — the cached set plus its replay cursor. */
export const unshieldedCacheKey = (groupId: string, accountIndex: number): string =>
  `@pnyx/midnight/unshielded/${groupId}/${accountIndex}`

export type UnshieldedCache = {
  readonly utxos: ReadonlyMap<string, UnshieldedUtxo>
  /** Newest first, capped at {@link ACTIVITY_CACHE_LIMIT}. */
  readonly activity: readonly MidnightActivity[]
  /** The transaction id the replay reached, so the next sync resumes rather than re-reads. */
  readonly transactionId: number
  /** The address the set was read for. A set is only meaningful for the address that owns it. */
  readonly address: string
}

type StoredUtxo = {
  owner: string
  tokenType: string
  /** Decimal string: JSON has no bigint, and a Number would lose atomic units. */
  value: string
  intentHash: string
  outputIndex: number
  ctime: number | null
  registeredForDustGeneration: boolean
  createdAtTxHash?: string
}

type StoredActivity = {
  transactionId: number
  hash: string
  timestamp?: string
  blockHeight?: number
  direction: MidnightDirection
  /** Signed decimal strings per token type — JSON has no bigint. */
  net: readonly [string, string][]
  /** Token types the transaction moved, whatever the net — a zero net is absent from `net`. */
  tokens: readonly string[]
  /** Our unshielded outputs the transaction spent, and the ones it gave back. */
  ourSpentCount: number
  ourCreatedCount: number
  fee?: string
  counterparties: readonly string[]
  /** The chain's identifiers for the transaction — how a send is matched to its row. */
  identifiers?: readonly string[]
  /** The chain's verdict, when the indexer reported one. */
  outcome?: {status: string; segments: readonly {id: number; success: boolean}[]}
}

/**
 * ⚠️ **An older blob is discarded, not upgraded.** v1 held no `activity`; v2 held no `createdAtTxHash` on
 * its UTxOs; v3 held no per-row `tokens`, so a self-send in it is indistinguishable from a row that
 * moved nothing — the field cannot be reconstructed from a net that cancelled to empty; v4 held no
 * input/output counts, and a row that reported `0 spent` would be a claim rather than an absence; v5
 * held them under their pre-rename keys, which the same argument rules out reading; v6 held no
 * `identifiers`, and those cannot be recomputed from a stored row — they live in the transaction, which
 * the cache does not keep — so a v6 row can never be matched to a send; **v7 held one row per feed
 * event rather than per transaction**, so a sponsored transaction — a faucet payout, say — sits in it
 * twice, each row carrying only its own part of what moved. That cannot be merged after the fact
 * either: the parts are already stored as independent rows and re-deriving which belong together would
 * be guessing at what the feed said. Upgrading any of these would
 * produce a wallet that looks complete while missing what the newer
 * surfaces read — a history starting mid-stream, or outputs with no link to the transaction that created
 * them. Discarding replays from zero, which is cheap and correct.
 */
type StoredCache = {
  version: 8
  address: string
  transactionId: number
  utxos: readonly StoredUtxo[]
  activity: readonly StoredActivity[]
}

/**
 * Decode a cached blob. `undefined` for absent *or* unreadable — both mean "resync", which is cheap and
 * always correct here. The reason is logged either way, because "no cache yet" and "the cache is corrupt"
 * are different facts even when the response to them is the same.
 */
export const parseUnshieldedCache = (raw: string | null): UnshieldedCache | undefined => {
  if (raw === null || raw === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    logger.warn('unshielded cache is not JSON; resyncing', {origin: ORIGIN, error: String(error)})
    return undefined
  }
  const cache = parsed as Partial<StoredCache>
  if (cache.version !== 8 || typeof cache.address !== 'string' || !Array.isArray(cache.utxos)) {
    logger.warn('unshielded cache has an unexpected shape; resyncing', {origin: ORIGIN})
    return undefined
  }
  const utxos = new Map<string, UnshieldedUtxo>()
  for (const stored of cache.utxos) {
    if (typeof stored?.value !== 'string' || !/^\d+$/.test(stored.value)) {
      logger.warn('dropping an unshielded cache row with an unreadable value', {origin: ORIGIN})
      continue
    }
    const utxo: UnshieldedUtxo = {
      owner: stored.owner,
      tokenType: stored.tokenType,
      value: BigInt(stored.value),
      intentHash: stored.intentHash,
      outputIndex: stored.outputIndex,
      ctime: stored.ctime ?? null,
      registeredForDustGeneration: stored.registeredForDustGeneration === true,
      ...(stored.createdAtTxHash === undefined ? {} : {createdAtTxHash: stored.createdAtTxHash}),
    }
    utxos.set(utxoKey(utxo), utxo)
  }
  const activity: MidnightActivity[] = []
  for (const stored of cache.activity ?? []) {
    if (typeof stored?.hash !== 'string' || typeof stored.transactionId !== 'number') {
      logger.warn('dropping an unreadable cached activity row', {origin: ORIGIN})
      continue
    }
    if (typeof stored.ourSpentCount !== 'number' || typeof stored.ourCreatedCount !== 'number') {
      // `?? 0` here would report "spent zero of your outputs", which is a statement about the
      // transaction rather than an admission that this row predates the field. Dropping the row makes
      // the sync replay it.
      logger.warn('dropping an activity row with no output counts', {origin: ORIGIN, hash: stored.hash})
      continue
    }
    const net = new Map<string, bigint>()
    for (const [token, value] of stored.net ?? []) {
      if (!/^-?\d+$/.test(value)) {
        logger.warn('dropping an activity amount that is not an integer', {origin: ORIGIN, hash: stored.hash})
        continue
      }
      net.set(token, BigInt(value))
    }
    // Re-validated through the same reader the live projection uses, so a status this build does not
    // recognise is dropped in both paths rather than trusted because it came from our own cache.
    const outcome = outcomeOf(stored.outcome)
    activity.push({
      transactionId: stored.transactionId,
      hash: stored.hash,
      ...(stored.timestamp === undefined ? {} : {timestamp: stored.timestamp}),
      ...(stored.blockHeight === undefined ? {} : {blockHeight: stored.blockHeight}),
      direction: stored.direction,
      netByToken: net,
      tokens: new Set(stored.tokens ?? []),
      ourSpentCount: stored.ourSpentCount,
      ourCreatedCount: stored.ourCreatedCount,
      ...(stored.fee === undefined || !/^\d+$/.test(stored.fee) ? {} : {fee: BigInt(stored.fee)}),
      counterparties: stored.counterparties ?? [],
      identifiers: stored.identifiers ?? [],
      ...(outcome === undefined ? {} : {outcome}),
    })
  }

  return {
    utxos,
    activity,
    transactionId: typeof cache.transactionId === 'number' ? cache.transactionId : 0,
    address: cache.address,
  }
}

export const serializeUnshieldedCache = (cache: UnshieldedCache): string => {
  if (cache.activity.length > ACTIVITY_CACHE_LIMIT) {
    logger.debug('activity cache truncated to its limit', {
      origin: ORIGIN,
      kept: ACTIVITY_CACHE_LIMIT,
      dropped: cache.activity.length - ACTIVITY_CACHE_LIMIT,
    })
  }
  const stored: StoredCache = {
    version: 8,
    address: cache.address,
    transactionId: cache.transactionId,
    activity: cache.activity.slice(0, ACTIVITY_CACHE_LIMIT).map((a) => ({
      transactionId: a.transactionId,
      hash: a.hash,
      ...(a.timestamp === undefined ? {} : {timestamp: a.timestamp}),
      ...(a.blockHeight === undefined ? {} : {blockHeight: a.blockHeight}),
      direction: a.direction,
      net: [...a.netByToken.entries()].map(([token, value]) => [token, value.toString()] as [string, string]),
      tokens: [...a.tokens],
      ourSpentCount: a.ourSpentCount,
      ourCreatedCount: a.ourCreatedCount,
      ...(a.fee === undefined ? {} : {fee: a.fee.toString()}),
      counterparties: a.counterparties,
      identifiers: [...a.identifiers],
      ...(a.outcome === undefined ? {} : {outcome: {status: a.outcome.status, segments: [...a.outcome.segments]}}),
    })),
    utxos: [...cache.utxos.values()].map((u) => ({
      owner: u.owner,
      tokenType: u.tokenType,
      value: u.value.toString(),
      intentHash: u.intentHash,
      outputIndex: u.outputIndex,
      ctime: u.ctime,
      registeredForDustGeneration: u.registeredForDustGeneration,
      ...(u.createdAtTxHash === undefined ? {} : {createdAtTxHash: u.createdAtTxHash}),
    })),
  }
  return JSON.stringify(stored)
}

/**
 * Read the cache for `(groupId, accountIndex)`, or `undefined`.
 *
 * The blob carries the address it was read for, so **checking is the caller's** (see
 * `readCachedUnshielded`): a screen can paint from disk immediately and validate once the address resolves,
 * rather than waiting on the wallet service to hand it one. Switching network changes the address a group
 * derives, so serving one network's UTxOs under another's would report funds the wallet cannot spend
 * there — which is why the address is stored, not merely assumed to match.
 */
export const loadUnshieldedCache = (
  groupId: string,
  accountIndex: number,
): Effect.Effect<UnshieldedCache | undefined, UnshieldedStoreError> =>
  Effect.tryPromise({
    try: () => storage.get(unshieldedCacheKey(groupId, accountIndex)),
    catch: (error) => new UnshieldedStoreError({reason: String(error)}),
  }).pipe(Effect.map(parseUnshieldedCache))

/** Persist the set and cursor together. Warns rather than throws: the chain remains the source of truth. */
export const saveUnshieldedCache = (
  groupId: string,
  accountIndex: number,
  cache: UnshieldedCache,
): Effect.Effect<void> =>
  Effect.tryPromise({
    try: () => storage.set(unshieldedCacheKey(groupId, accountIndex), serializeUnshieldedCache(cache)),
    catch: (error) => new UnshieldedStoreError({reason: String(error)}),
  }).pipe(
    // Announced after the write, so a listener that re-reads sees the new set rather than the old one.
    Effect.tap(() => publishStoreChange('midnight-unshielded')),
    Effect.catchTag('UnshieldedStoreError', (error) =>
      Effect.sync(() => {
        logger.warn('failed to cache the unshielded UTxO set; the next read replays', {
          origin: ORIGIN,
          groupId,
          error: error.reason,
        })
      }),
    ),
  )

/**
 * Drop the cached set, so the next read has to replay rather than answer from it.
 *
 * ⚠️ For a wallet **nothing is listening to**. A live feed rewrites its own wallet's cache when a block
 * arrives; a wallet with no feed keeps whatever it last stored, which is wrong the moment a transaction
 * spends its inputs — and a co-funded send spends the inputs of contributors that are not the selected
 * wallet. Dropping it turns a stale figure into an honest absence: the connector then reports the
 * balance as unknown rather than as a number that is too high, and the next read replays.
 *
 * Warns rather than throws, like {@link saveUnshieldedCache}: failing to drop a cache is a staleness
 * problem, and throwing here would break a send that has already gone.
 */
export const invalidateUnshieldedCache = (groupId: string, accountIndex: number): Effect.Effect<void> =>
  Effect.tryPromise({
    try: () => storage.remove(unshieldedCacheKey(groupId, accountIndex)),
    catch: (error) => new UnshieldedStoreError({reason: String(error)}),
  }).pipe(
    Effect.tap(() => publishStoreChange('midnight-unshielded')),
    Effect.catchTag('UnshieldedStoreError', (error) =>
      Effect.sync(() => {
        logger.warn('failed to drop the unshielded cache; it may answer with a pre-spend set', {
          origin: ORIGIN,
          groupId,
          error: error.reason,
        })
      }),
    ),
  )
