/**
 * Where a Midnight funds wallet's DUST state lives.
 *
 * A sibling of `./state-store.ts`, and deliberately a *different* store: the shielded state is the one
 * whose loss can lose money, because a contract-minted coin exists nowhere else. A DUST state is not
 * like that — every generation entry is re-readable from the indexer, so losing this costs a re-sync
 * (~40 s) and nothing more. Keeping them apart means a DUST corruption can be discarded and rebuilt
 * without going anywhere near coins that cannot be.
 *
 * ⚠️ **But it must still be persisted, and persisted at the right moment.** Paying a fee spends a DUST
 * output, and the returned state is what records that spend as pending. Keeping the pre-spend state
 * would let the next transfer pick the same output, and the ledger rejects the pair — so a self-funded
 * send has to save before it is considered done, exactly as the shielded rail does with its coins.
 *
 * Profile-scoped and keyed by `(groupId, accountIndex)`, for the same reasons as the shielded store.
 *
 * @module
 */

import type {DustStateBytes} from '@pnyx/midnight-native'

import {Data, Effect} from 'effect'

import {logger} from '../../../logger'
import {storage} from '../../../platform/storage'
import {publishStoreChange} from '../../store-change'

/** Storage itself failed. A *malformed* blob is answered with `undefined` by the parsers instead. */
export class DustStoreError extends Data.TaggedError('DustStoreError')<{readonly reason: string}> {}

const get = (key: string): Effect.Effect<string | null, DustStoreError> =>
  Effect.tryPromise({try: () => storage.get(key), catch: (error) => new DustStoreError({reason: String(error)})})

const set = (key: string, value: string): Effect.Effect<void, DustStoreError> =>
  Effect.tryPromise({try: () => storage.set(key, value), catch: (error) => new DustStoreError({reason: String(error)})})

const remove = (key: string): Effect.Effect<void, DustStoreError> =>
  Effect.tryPromise({try: () => storage.remove(key), catch: (error) => new DustStoreError({reason: String(error)})})

const ORIGIN = 'midnight-dust-state'

/** `@pnyx/midnight/dust-state/<groupId>/<accountIndex>` — hex of the serialized `DustLocalState`. */
export const dustStateKey = (groupId: string, accountIndex: number): string =>
  `@pnyx/midnight/dust-state/${groupId}/${accountIndex}`

/**
 * `@pnyx/midnight/dust-synced-at/<groupId>/<accountIndex>` — unix seconds of the last successful sync.
 *
 * Not a chain cursor. The fast sync reads this address's own entries every time rather than resuming
 * from an index, so what a caller needs is *when* this ran, for display.
 *
 * ⚠️ It is **not** the staleness signal. Age proves nothing about a DUST balance, which is recomputed
 * from the stored state against the current clock on every read — see {@link dustSyncedWatermarkKey}.
 */
export const dustSyncedAtKey = (groupId: string, accountIndex: number): string =>
  `@pnyx/midnight/dust-synced-at/${groupId}/${accountIndex}`

/**
 * `@pnyx/midnight/dust-watermark/<groupId>/<accountIndex>` — the **unshielded** transaction id this
 * DUST state was synced against.
 *
 * This is the staleness signal. DUST outputs change when NIGHT arrives or when this wallet spends —
 * both of which move the unshielded watermark, which the app already keeps current for free. Comparing
 * the two says whether a re-sync would find anything, without a network call of its own.
 * `services/midnight/dust-staleness.ts` is the rule.
 */
export const dustSyncedWatermarkKey = (groupId: string, accountIndex: number): string =>
  `@pnyx/midnight/dust-watermark/${groupId}/${accountIndex}`

/**
 * `@pnyx/midnight/dust-spent/<groupId>/<accountIndex>` — `1` once this wallet has spent DUST.
 *
 * ⚠️ **A one-way door, and it disables the fast sync.** The fast sync reads this address's generation
 * entries and assumes every DUST output is at `seq` 0, which is true only of an output never spent.
 * Spending produces a *successor* at a higher `seq`, the per-address feed does not carry successors,
 * and `seq` feeds the nonce — so a rebuilt state would hold outputs that derive the wrong nonce and are
 * **unspendable**, while looking like a perfectly good balance. Recording the fact is what lets
 * `syncDust` refuse instead of quietly producing that.
 */
export const dustSpentKey = (groupId: string, accountIndex: number): string =>
  `@pnyx/midnight/dust-spent/${groupId}/${accountIndex}`

/**
 * `@pnyx/midnight/dust-pending/<groupId>/<accountIndex>` — the post-spend state of a submitted but
 * unconfirmed transaction, JSON `{state, expiresAt, identifiers}`.
 *
 * ⚠️ **Two states, because there is nothing to overlay.** Every other rail can express "spent but
 * unconfirmed" by hiding a UTxO from a list. A DUST state is an opaque native blob, so the same idea
 * has to be expressed by keeping both versions: {@link dustStateKey} stays what the chain has
 * confirmed, and this is what will be true if the transaction lands.
 *
 * Writing the post-spend state over the confirmed one — what this replaces — had no counterpart. A
 * transaction that never landed took its DUST output with it, and since the fast sync refuses a wallet
 * that has spent DUST, that loss was permanent.
 *
 * `expiresAt` is the transaction's **own TTL**, not a timeout of ours. Before it the transaction can
 * still be accepted and reverting would invite a double-spend; after it the node can never accept it,
 * so holding the output back only strands it. A constant would be wrong in both directions.
 */
/**
 * `@pnyx/midnight/dust-network/<groupId>/<accountIndex>` — which network the DUST state belongs to.
 *
 * A sidecar rather than part of the key, so an existing state is not orphaned: a wallet that has spent
 * DUST cannot rebuild from the fast sync, and rekeying would strand exactly those. Read the same way as
 * the shielded stamp — an unstamped state predates this and is returned rather than refused, because
 * guessing its network on read would cement the guess.
 */
export const dustNetworkKey = (groupId: string, accountIndex: number): string =>
  `@pnyx/midnight/dust-network/${groupId}/${accountIndex}`

/**
 * `@pnyx/midnight/dust-block-time/<groupId>/<accountIndex>` — the **block** time the state belongs to.
 *
 * ⚠️ Not when the sync ran; the ledger timestamp its tree roots correspond to, taken from the events
 * the sync replayed. A DUST spend must declare exactly this as its `ctime`, because the node looks the
 * roots up under it (`root_history.get(ctime)`), and a wall-clock reading resolves to a default root
 * the proof never used — reported as `InvalidDustSpendProof`. See `docs/DUST_SPEND_PROOF.md`.
 *
 * Absent, or `0`, means the state was built without a replay and **cannot be spent from**.
 */
export const dustBlockTimeKey = (groupId: string, accountIndex: number): string =>
  `@pnyx/midnight/dust-block-time/${groupId}/${accountIndex}`

/**
 * `@pnyx/midnight/dust-cursor/<groupId>/<accountIndex>` — how far both trees have been filled.
 *
 * `"<nextGeneration>:<nextCommitment>"`. Written with the state, because it is what an **incremental**
 * sync resumes from: the next index each tree expects, which is the one thing a persisted state cannot
 * report about itself.
 *
 * ⚠️ **Without this there is only a rebuild**, and a rebuild is invalid for a wallet that has spent
 * DUST — its outputs have successors at a higher `seq` that the per-address feed does not carry, so a
 * reconstruction derives the wrong nonces and produces unspendable outputs behind a plausible balance.
 * That is why a wallet used to lose the ability to sync the moment it paid a fee.
 */
export const dustCursorKey = (groupId: string, accountIndex: number): string =>
  `@pnyx/midnight/dust-cursor/${groupId}/${accountIndex}`

export const dustPendingKey = (groupId: string, accountIndex: number): string =>
  `@pnyx/midnight/dust-pending/${groupId}/${accountIndex}`

/**
 * Every spend of ours the chain has confirmed, with what it takes to reinstate its successor.
 *
 * ⚠️ **This is a cache of immutable history, and that is what makes it worth keeping.** A spend that
 * happened will always have happened, so the list only ever grows.
 *
 * Without it a sync can only ever advance each output's history by **one** step. A DUST spend writes a
 * successor at `seq + 1`, and a successor's nullifier is built from its own post-fee `initial_value` and
 * the spend's `ctime` — neither derivable from key material — so the nullifier of the *next* spend
 * cannot be asked about until the current successor has actually been built. Discovery is therefore
 * sequential in `seq`: a wallet that paid five fees from one output needs five discover-and-rebuild
 * rounds to reach the truth, every single sync. Persisting what has already been discovered pays that
 * cost once per new spend instead of once per sync, and a routine sync becomes a single rebuild that
 * applies a known list in one ascending walk.
 *
 * Network-scoped by the same stamp as the state itself: a nullifier and commitment index are facts
 * about one chain.
 */
export const dustRepairsKey = (groupId: string, accountIndex: number): string =>
  `@pnyx/midnight/dust-repairs/${groupId}/${accountIndex}`

const toHex = (bytes: Uint8Array): string => {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

/**
 * Decode a stored blob. `undefined` for absent, and `undefined` for unreadable **too**.
 *
 * ⚠️ The opposite call from `parseStoredState`, on purpose. That one throws rather than overwrite,
 * because a coin it cannot read is a coin that exists nowhere else. A DUST state is fully re-derivable
 * from the indexer, so refusing to proceed would strand a wallet over something a 40-second re-sync
 * fixes. The corruption is logged rather than swallowed.
 */
export const parseStoredDustState = (raw: string | null): DustStateBytes | undefined => {
  if (raw === null || raw === '') return undefined
  if (raw.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(raw)) {
    logger.warn('the stored dust state is not hex; discarding it and re-syncing', {
      origin: ORIGIN,
      chars: raw.length,
    })
    return undefined
  }
  const out = new Uint8Array(raw.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(raw.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** Unix seconds, or `undefined` when absent or unusable. */
export const parseStoredSyncedAt = (raw: string | null): number | undefined => {
  if (raw === null || raw === '') return undefined
  const parsed = Number.parseInt(raw, 10)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

/**
 * A stored watermark, or `undefined` when absent or unusable.
 *
 * Zero is kept, unlike in {@link parseStoredSyncedAt}: a wallet whose unshielded feed has shown nothing
 * has watermark zero, and rejecting it would make that wallet permanently "unknown".
 */
export const parseStoredWatermark = (raw: string | null): number | undefined => {
  if (raw === null || raw === '') return undefined
  const parsed = Number.parseInt(raw, 10)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined
}

/**
 * A submitted transfer's post-spend DUST state, waiting to be confirmed or to expire.
 */
export type PendingDustSpend = {
  /** The state to adopt if the transaction lands. */
  readonly state: DustStateBytes
  /** Unix seconds after which the transaction can never be accepted — its own TTL. */
  readonly expiresAt: number
  /** The transaction's identifiers, so a landing can be recognised. A device tx has no hash. */
  readonly identifiers: readonly string[]
}

type StoredPending = {state?: unknown; expiresAt?: unknown; identifiers?: unknown}

/** Decode a stored pending spend. Anything unreadable is treated as absent, and logged. */
export const parseStoredPendingDust = (raw: string | null): PendingDustSpend | undefined => {
  if (raw === null || raw === '') return undefined
  let parsed: StoredPending
  try {
    parsed = JSON.parse(raw) as StoredPending
  } catch (error) {
    logger.warn('the pending dust spend is not JSON; discarding it', {origin: ORIGIN, error: String(error)})
    return undefined
  }
  const state = typeof parsed.state === 'string' ? parseStoredDustState(parsed.state) : undefined
  if (state === undefined || typeof parsed.expiresAt !== 'number' || !Array.isArray(parsed.identifiers)) {
    logger.warn('the pending dust spend is malformed; discarding it', {origin: ORIGIN})
    return undefined
  }
  return {
    state,
    expiresAt: parsed.expiresAt,
    identifiers: parsed.identifiers.filter((id): id is string => typeof id === 'string'),
  }
}

/**
 * The confirmed state — what the chain has actually shown us.
 *
 * Callers that want to **spend** want {@link loadDustState}, which applies the pending spend. This one
 * exists for the promote/expire logic and for anything that must reason about the chain's own view.
 */
export const loadConfirmedDustState = (
  groupId: string,
  accountIndex: number,
  network: string,
): Effect.Effect<DustStateBytes | undefined, DustStoreError> =>
  Effect.gen(function* () {
    const stamped = yield* get(dustNetworkKey(groupId, accountIndex))
    if (stamped !== null && stamped !== '' && stamped !== network) {
      logger.info('the stored dust state belongs to another network; reporting none', {
        origin: ORIGIN,
        groupId,
        accountIndex,
        stored: stamped,
        asked: network,
      })
      return undefined
    }
    return parseStoredDustState(yield* get(dustStateKey(groupId, accountIndex)))
  })

/** The pending spend if one stands and has not expired; `undefined` otherwise. Expired ones are cleared. */
export const loadPendingDustSpend = (
  groupId: string,
  accountIndex: number,
  nowUnixSecs: number,
): Effect.Effect<PendingDustSpend | undefined, DustStoreError> =>
  Effect.gen(function* () {
    const pending = parseStoredPendingDust(yield* get(dustPendingKey(groupId, accountIndex)))
    if (pending === undefined) return undefined
    if (nowUnixSecs <= pending.expiresAt) return pending
    // Self-healing on read: past its TTL the transaction can never be accepted, so the DUST it named is
    // free again and the confirmed state is already correct.
    logger.info('a pending dust spend passed its TTL; reverting to the confirmed state', {
      origin: ORIGIN,
      groupId,
      accountIndex,
      expiredBySecs: nowUnixSecs - pending.expiresAt,
    })
    yield* discardPendingDustSpend(groupId, accountIndex)
    return undefined
  })

/**
 * The state to **spend from**: the pending one while it stands, the confirmed one otherwise.
 *
 * This is the default read because both real callers — building a transfer and showing a balance —
 * want the wallet's own best belief, not the chain's lagging one. A caller that genuinely wants the
 * confirmed view has to say so, which is the safer way round.
 */
export const loadDustState = (
  groupId: string,
  accountIndex: number,
  network: string,
): Effect.Effect<DustStateBytes | undefined, DustStoreError> =>
  Effect.gen(function* () {
    const confirmed = yield* loadConfirmedDustState(groupId, accountIndex, network)
    // The network guard is on the confirmed state, and a pending spend only ever describes that state —
    // so a state belonging to another network takes its pending spend out of scope with it.
    if (confirmed === undefined) return undefined
    const pending = yield* loadPendingDustSpend(groupId, accountIndex, Math.floor(Date.now() / 1000))
    return pending?.state ?? confirmed
  })

/** Record a submitted transfer's post-spend state. Replaces any previous pending spend. */
export const savePendingDustSpend = (
  groupId: string,
  accountIndex: number,
  pending: PendingDustSpend,
): Effect.Effect<void, DustStoreError> =>
  set(
    dustPendingKey(groupId, accountIndex),
    JSON.stringify({state: toHex(pending.state), expiresAt: pending.expiresAt, identifiers: pending.identifiers}),
  ).pipe(Effect.tap(() => publishStoreChange('midnight-dust')))

/** Drop a pending spend without adopting it — it expired, or the chain showed it never happened. */
export const discardPendingDustSpend = (groupId: string, accountIndex: number): Effect.Effect<void, DustStoreError> =>
  remove(dustPendingKey(groupId, accountIndex)).pipe(Effect.tap(() => publishStoreChange('midnight-dust')))

/**
 * The transaction landed: the pending state becomes the confirmed one.
 *
 * Confirmed first, pending cleared second. A crash between them leaves the same state under both keys,
 * which reads identically — whereas clearing first would revert a spend the chain has already applied
 * and hand the next transfer an output that no longer exists.
 */
export const promotePendingDustSpend = (
  groupId: string,
  accountIndex: number,
): Effect.Effect<boolean, DustStoreError> =>
  Effect.gen(function* () {
    const pending = parseStoredPendingDust(yield* get(dustPendingKey(groupId, accountIndex)))
    if (pending === undefined) return false
    yield* set(dustStateKey(groupId, accountIndex), toHex(pending.state))
    yield* remove(dustPendingKey(groupId, accountIndex))
    logger.info('a pending dust spend was confirmed and promoted', {origin: ORIGIN, groupId, accountIndex})
    yield* publishStoreChange('midnight-dust')
    return true
  })

/**
 * Persist a DUST state and stamp when it was synced.
 *
 * The two writes are not atomic, and the order is chosen so the failure mode is harmless: state first,
 * stamp second. A crash between them leaves a good state that merely *looks* stale, which costs a
 * re-sync. The reverse order would leave a fresh stamp over an old state — a wallet confidently
 * reporting a balance it no longer holds.
 */
export type DustTreeCursor = {
  /** Next generation-tree index this state has not accounted for. */
  readonly nextGeneration: number
  /** Next commitment-tree index this state has not accounted for. */
  readonly nextCommitment: number
}

export const saveDustState = (
  groupId: string,
  accountIndex: number,
  state: DustStateBytes,
  syncedAtUnixSecs: number,
  /** Required so it cannot be forgotten — an unstamped state is what made a switch show another chain's DUST. */
  network: string,
  /** The ledger block time the state's roots belong to — `0` when nothing established one. */
  blockTimeSecs: number,
  /**
   * How far both trees are filled, so the next sync can advance this state instead of rebuilding it.
   *
   * Required rather than optional: a state stored without its cursor can only ever be rebuilt, and for
   * a wallet that has spent DUST a rebuild is refused — which is exactly how one used to become
   * unsyncable for ever.
   */
  cursor: DustTreeCursor,
  unshieldedWatermark?: number,
): Effect.Effect<void, DustStoreError> =>
  Effect.gen(function* () {
    yield* set(dustStateKey(groupId, accountIndex), toHex(state))
    yield* set(dustNetworkKey(groupId, accountIndex), network)
    yield* set(dustBlockTimeKey(groupId, accountIndex), String(blockTimeSecs))
    yield* set(dustCursorKey(groupId, accountIndex), `${cursor.nextGeneration}:${cursor.nextCommitment}`)
    yield* set(dustSyncedAtKey(groupId, accountIndex), String(syncedAtUnixSecs))
    // Written last, and only when known. A watermark ahead of the state it describes would report a
    // stale set as current — the one direction of this that loses money rather than time.
    if (unshieldedWatermark !== undefined) {
      yield* set(dustSyncedWatermarkKey(groupId, accountIndex), String(unshieldedWatermark))
    }
    logger.debug('stored the dust state', {
      origin: ORIGIN,
      groupId,
      accountIndex,
      bytes: state.length,
      watermark: unshieldedWatermark ?? null,
    })
    // After all three writes, so a listener re-reading sees a consistent state/stamp/watermark trio.
    yield* publishStoreChange('midnight-dust')
  })

/** When the stored state was last synced, or `undefined` if there is none. */
export const loadDustSyncedAt = (
  groupId: string,
  accountIndex: number,
): Effect.Effect<number | undefined, DustStoreError> =>
  get(dustSyncedAtKey(groupId, accountIndex)).pipe(Effect.map(parseStoredSyncedAt))

/**
 * Record that this wallet has spent DUST. Never unset — see {@link dustSpentKey}.
 *
 * Failure is logged, not thrown: the send it follows has already landed, and reporting a completed
 * send as failed would be worse. The cost of a lost flag is a later fast sync that should have been
 * refused, which is why it is logged at `error`.
 */
export const markDustSpent = (groupId: string, accountIndex: number): Effect.Effect<void> =>
  set(dustSpentKey(groupId, accountIndex), '1').pipe(
    Effect.catchTag('DustStoreError', (error) =>
      Effect.sync(() => {
        logger.error('could not record that this wallet spent DUST; a later fast sync may build a bad state', {
          origin: ORIGIN,
          groupId,
          accountIndex,
          error: error.reason,
        })
      }),
    ),
  )

/** Whether this wallet has ever spent DUST. Absent reads as `false`, which is the pre-spend truth. */
export const loadDustHasSpent = (groupId: string, accountIndex: number): Effect.Effect<boolean, DustStoreError> =>
  get(dustSpentKey(groupId, accountIndex)).pipe(Effect.map((raw) => raw === '1'))

/**
 * The block time the stored state's roots belong to, or `undefined` when none was recorded.
 *
 * `undefined` and `0` both mean the state cannot be spent from — see {@link dustBlockTimeKey}.
 */
export const loadDustBlockTime = (
  groupId: string,
  accountIndex: number,
): Effect.Effect<number | undefined, DustStoreError> =>
  get(dustBlockTimeKey(groupId, accountIndex)).pipe(Effect.map(parseStoredWatermark))

/**
 * How far both trees are filled, or `undefined` when this state predates the cursor.
 *
 * `undefined` means **rebuild only** — there is no safe place to resume from, so the caller must decide
 * whether a rebuild is allowed for this wallet.
 */
/** One confirmed spend of ours, and the inputs that reinstate its successor. */
export type StoredDustRepair = {
  readonly nullifier: string
  /** Start of the spending transaction's commitment range — see `DustSpendRepair`. */
  readonly commitmentStart: number
  /** Exclusive end of that range. */
  readonly commitmentEnd: number
  /** Start of the same transaction's generation range. */
  readonly generationStart: number
  /** Exclusive end of the generation range. */
  readonly generationEnd: number
  /** Every DUST event the spending transaction published, tagged-serialized hex, in order. */
  readonly spendEvents: readonly string[]
}

const parseStoredRepairs = (raw: string | undefined | null): readonly StoredDustRepair[] => {
  if (raw === undefined || raw === null || raw === '') return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) throw new Error('not an array')
    let superseded = 0
    const rows = parsed.flatMap((one): readonly StoredDustRepair[] => {
      const row = one as Record<string, unknown>
      // A malformed row is dropped, never defaulted: a repair with index 0 substituted for a missing
      // one would insert at the wrong place, and the ledger only refuses that after the tree has
      // advanced past the right index.
      if (typeof row?.nullifier !== 'string') return []
      // ⚠️ The pre-2026-09-01 shape, `{commitmentIndex, spendEvent}`, held the successor's index and a
      // single event. It is counted rather than silently skipped, because a device upgrading across
      // that change drops its whole list at once and "unreadable" would be the wrong story.
      if (typeof row.commitmentIndex === 'number' || typeof row.spendEvent === 'string') {
        superseded += 1
        return []
      }
      if (typeof row.commitmentStart !== 'number' || !Number.isSafeInteger(row.commitmentStart)) return []
      if (typeof row.commitmentEnd !== 'number' || !Number.isSafeInteger(row.commitmentEnd)) return []
      if (typeof row.generationStart !== 'number' || !Number.isSafeInteger(row.generationStart)) return []
      if (typeof row.generationEnd !== 'number' || !Number.isSafeInteger(row.generationEnd)) return []
      if (!Array.isArray(row.spendEvents)) return []
      const events = row.spendEvents.flatMap((event) => (typeof event === 'string' ? [event] : []))
      if (events.length !== row.spendEvents.length || events.length === 0) return []
      return [
        {
          nullifier: row.nullifier,
          commitmentStart: row.commitmentStart,
          commitmentEnd: row.commitmentEnd,
          generationStart: row.generationStart,
          generationEnd: row.generationEnd,
          spendEvents: events,
        },
      ]
    })
    if (superseded > 0) {
      logger.info('stored dust repairs predate the commitment-range format; the next sync rediscovers them', {
        origin: ORIGIN,
        superseded,
        kept: rows.length,
      })
    }
    return rows
  } catch (error) {
    // Losing the cache costs sync time, never correctness — the next sync rediscovers every level.
    logger.warn('the stored dust repair list is unreadable; rediscovering from scratch', {
      origin: ORIGIN,
      error: String(error),
    })
    return []
  }
}

/**
 * The spends already discovered for this wallet, or an empty list when none have been.
 *
 * Empty is not an error and not "none exist" — it means this wallet has not been synced since the list
 * was introduced, and the next sync will rediscover every level. See {@link dustRepairsKey}.
 */
export const loadDustRepairs = (
  groupId: string,
  accountIndex: number,
  network: string,
): Effect.Effect<readonly StoredDustRepair[], DustStoreError> =>
  Effect.gen(function* () {
    // Guarded by the same network stamp as the state: these are facts about one chain.
    const stamped = yield* get(dustNetworkKey(groupId, accountIndex))
    if (stamped !== undefined && stamped !== null && stamped !== network) {
      logger.debug('the stored dust repairs belong to another network, so they are ignored', {
        origin: ORIGIN,
        groupId,
        stored: stamped,
        asked: network,
      })
      return []
    }
    return parseStoredRepairs(yield* get(dustRepairsKey(groupId, accountIndex)))
  })

/**
 * Record the spends a sync knows about. Append-only in effect: callers pass what the sync returned,
 * which is everything it was given plus whatever it newly found.
 */
export const saveDustRepairs = (
  groupId: string,
  accountIndex: number,
  repairs: readonly StoredDustRepair[],
): Effect.Effect<void, DustStoreError> =>
  set(dustRepairsKey(groupId, accountIndex), JSON.stringify(repairs)).pipe(
    Effect.tap(() => publishStoreChange('midnight-dust')),
  )

export const loadDustCursor = (
  groupId: string,
  accountIndex: number,
): Effect.Effect<DustTreeCursor | undefined, DustStoreError> =>
  get(dustCursorKey(groupId, accountIndex)).pipe(
    Effect.map((raw) => {
      if (raw === undefined || raw === null) return undefined
      const [generation, commitment] = raw.split(':')
      const nextGeneration = Number(generation)
      const nextCommitment = Number(commitment)
      // A malformed cursor reads as absent rather than as zero: resuming from 0 against a filled tree
      // would insert at the wrong index, and the ledger refuses that — loudly, but only later.
      if (!Number.isSafeInteger(nextGeneration) || !Number.isSafeInteger(nextCommitment)) {
        logger.warn('the stored dust cursor is unreadable; this state can only be rebuilt', {
          origin: ORIGIN,
          groupId,
          accountIndex,
          raw,
        })
        return undefined
      }
      return {nextGeneration, nextCommitment}
    }),
  )

/**
 * The stored state **and** the block time its roots belong to, read together.
 *
 * ⚠️ **They are only meaningful as a pair, and reading them apart is a real defect.** A spend proof
 * commits to the state's tree roots and the node looks its own up under the declared `ctime`; a state
 * from one sync paired with another sync's timestamp resolves to roots the proof never used, and the
 * node reports that as `InvalidDustSpendProof` — naming the proof, not the mismatch.
 *
 * That is not hypothetical: `send-self-funded.ts` read the state at the start of a build and the block
 * time fifty lines later, with a vault unlock, an unshielded sync and an artifact fetch in between. A
 * DUST refresh completing inside that window produced exactly the `170` above. It could not bite while
 * every state's block time was `0`, because the send refused before building.
 *
 * Two reads back to back rather than one blob: the keys are separate on disk and rekeying them would
 * orphan every stored state. Microseconds apart is enough — the window that mattered was seconds.
 */
export const loadDustStateForSpend = (
  groupId: string,
  accountIndex: number,
  network: string,
): Effect.Effect<{state: DustStateBytes; blockTimeSecs: number} | undefined, DustStoreError> =>
  Effect.gen(function* () {
    const state = yield* loadDustState(groupId, accountIndex, network)
    if (state === undefined) return undefined
    const blockTimeSecs = yield* loadDustBlockTime(groupId, accountIndex)
    return {state, blockTimeSecs: blockTimeSecs ?? 0}
  })

/** The unshielded watermark the stored state was synced against, or `undefined` if unrecorded. */
export const loadDustSyncedWatermark = (
  groupId: string,
  accountIndex: number,
): Effect.Effect<number | undefined, DustStoreError> =>
  get(dustSyncedWatermarkKey(groupId, accountIndex)).pipe(Effect.map(parseStoredWatermark))

/**
 * Whether a stored state is fresh enough to spend from.
 *
 * ⚠️ **Staleness matters more here than for a coin balance.** DUST accrues continuously, so an old
 * state under-reports what is spendable — harmless — but it also may not know about an output that has
 * since been spent elsewhere, which is not. `maxAgeSecs` is the caller's call; the point is that
 * "there is a state" and "the state is current" are different questions and only one of them is
 * answered by the state existing.
 */
export const isDustStateFresh = (
  syncedAtUnixSecs: number | undefined,
  nowUnixSecs: number,
  maxAgeSecs: number,
): boolean => syncedAtUnixSecs !== undefined && nowUnixSecs - syncedAtUnixSecs <= maxAgeSecs
