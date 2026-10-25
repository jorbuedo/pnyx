/**
 * Syncing this wallet's DUST, the fast way.
 *
 * The expensive route is replaying the whole ledger event stream — 1.45M events on preprod, which is
 * what makes a first DUST sync cost other wallets over an hour. This takes the cheap one, which is
 * available because we drive the ledger crate directly rather than the TS wallet SDK:
 *
 * 1. ask the indexer for **this address's own** generation entries (34 of them for a real test wallet,
 *    against 1.45M events);
 * 2. for each, advance both Merkle trees to its index with **one collapsed update per gap** — the range
 *    below our first entry, 0..238,130 on preprod, is a single **343-byte** blob;
 * 3. insert the entry: generation info, commitment, and the DUST output it backs.
 *
 * ⚠️ **The two collapses are not interchangeable.** {@link dustApplyGenerationCollapsedUpdate} takes the
 * indexer's blob and moves `first_free` to `end + 1`, which is what skips a range. `dustCollapse*Tree`
 * is *local* — it discards witnesses for leaves already present and leaves `first_free` alone, so using
 * it to skip yields a tree that refuses the next insert with `CollapsedIndex`.
 *
 * ⚠️ **A gapped indexer breaks this for everyone.** The ledger inserts leaves in order, so a stream or
 * a feed that skips an index is unusable by any wallet — the same crate raises the same error inside the
 * TS SDK. Preprod's public indexer was reported serving gaps on 2026-08-21. A failure here says so.
 *
 * @module
 */

import {
  type DustBalance,
  type DustStateBytes,
  dustApplyCommitmentCollapsedUpdate,
  dustApplyDtimeUpdate,
  dustApplyGeneration,
  dustApplyGenerationCollapsedUpdate,
  dustNullifiers,
  dustRemoveUtxos,
  dustReplayEvents,
  dustStateNew,
  dustTreeRoots,
  spendableDustAt,
} from '@pnyx/midnight-native'
import {Data, Effect} from 'effect'

import {logger} from '../../../logger'
import {
  type DustIndexerError,
  fetchCommitmentUpdate,
  fetchDustTreeTip,
  fetchGenerationEntries,
  fetchGenerationUpdate,
  fetchSpentNullifiers,
} from './dust-indexer'
import type {DustTreeCursor} from './dust-state-store'

const ORIGIN = 'dust-sync'

/**
 * The fast sync could not build a state.
 *
 * ⚠️ Three genuinely different situations, and only `spent-before` is ours. `unordered-feed` and
 * `missing-update` both mean the **indexer** is serving something no wallet driving this crate can use
 * — the gap bug reported on preprod's public indexer on 2026-08-21 — so they are worth reporting as an
 * indexer fault rather than as "your DUST could not be read". `native` is the Rust bridge refusing, and
 * it is a *failure* rather than an Effect defect on purpose: `Effect.promise` would turn a rejected
 * bridge call into something no `catchAll` can see.
 */
export class DustSyncError extends Data.TaggedError('DustSyncError')<{
  readonly cause: 'spent-before' | 'unordered-feed' | 'missing-update' | 'native'
  readonly reason: string
}> {}

/** Hex to bytes, for handing a nullifier straight back to the native side. */
const hexToBytes = (text: string): Uint8Array => {
  const out = new Uint8Array(text.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16)
  return out
}

const nativeStep = <A>(run: () => Promise<A>): Effect.Effect<A, DustSyncError> =>
  Effect.tryPromise({try: run, catch: (error) => new DustSyncError({cause: 'native', reason: String(error)})})

export type DustSyncResult = {
  readonly state: DustStateBytes
  /**
   * The block time the state now belongs to, in unix seconds, or `0` if the replay found nothing.
   *
   * ⚠️ **This is what a DUST spend must declare as its `ctime`.** The proof's tree roots are only
   * looked up under a timestamp the ledger knows, and this is the one they correspond to.
   */
  readonly syncTimeSecs: number
  /**
   * How far both trees are now filled, for the next sync to resume from.
   *
   * ⚠️ This is what makes an **advance** possible instead of a rebuild, and a rebuild is refused for a
   * wallet that has spent DUST. Persist it with the state.
   */
  readonly cursor: DustTreeCursor
  /**
   * Every spend this sync knows about — what it was given plus whatever it newly discovered. Persist
   * it: it is what stops the next sync re-walking each output's history a rebuild at a time.
   */
  readonly repairs: readonly DustSpendRepair[]
  /**
   * Whether a further step remains — spends found this round whose successors are not in the state yet.
   *
   * The state returned is spendable regardless: the roots are the chain's at any depth, and only value
   * is outstanding. A caller that wants the rest simply syncs again with the persisted list.
   */
  readonly moreToRepair: boolean
  /**
   * The block whose roots this state's trees were collapsed to, or `0` when none was reached.
   *
   * ⚠️ Reported so a caller can compare roots against **that** block rather than the current tip. The
   * chain moves every few seconds, so a comparison against "now" only measures elapsed time — which is
   * how a control that could not be affected by any local change came back false.
   */
  readonly collapsedAtHeight: number
  /** How many of this wallet's entries were inserted **this run**. */
  readonly entries: number
  /** How many collapsed updates were applied — the measure of what the fast path saved. */
  readonly collapses: number
  readonly balance: DustBalance
}

/**
 * Sync from scratch and report the balance.
 *
 * Deliberately not incremental yet: a resumable sync needs a persisted state plus a watermark, and
 * getting that wrong caches a wrong balance rather than failing. This builds a fresh state each time,
 * which is affordable precisely because the fast path makes it seconds rather than an hour.
 *
 * ⚠️ **Only correct for a wallet that has never spent DUST.** The fast path reads this address's
 * generation entries, which carry no `seq`, so every output is taken to be at `seq` 0 — true of an
 * output never spent. A spend produces a *successor* at a higher `seq`, `seq` feeds the nonce, and the
 * per-address feed does not carry successors: rebuilding such a wallet yields outputs that derive the
 * wrong nonce and cannot be spent, while showing a balance that looks right. Recovering that needs the
 * event-replay path (~1.45M events), which this is not.
 *
 * {@link DustSyncParams.spentDustBefore} is required rather than documented so the question cannot be
 * skipped: a caller must state what it knows, and `true` is refused here rather than silently ruined.
 */
export type DustSyncParams = {
  readonly indexerUrl: string
  readonly dustAddress: string
  readonly dustRoleKey: Uint8Array
  /** Unix seconds to report the balance at. A DUST balance is a function of time. */
  readonly atUnixSecs: bigint
  /** Highest generation index to look for. Wide by default — see `fetchGenerationEntries`. */
  readonly searchTo?: number
  /**
   * Whether this wallet has ever spent DUST — `loadDustHasSpent`.
   *
   * ⚠️ **This refuses a rebuild, not a sync.** A spend leaves a successor output at `seq + 1` that the
   * per-address feed does not carry, so reconstructing from scratch derives the wrong nonce and yields
   * unspendable outputs behind a plausible balance. Advancing a state that already holds the successor
   * is unaffected — pass {@link resume} and this becomes irrelevant.
   */
  readonly spentDustBefore: boolean
  /**
   * The state to advance, and how far its trees are filled — `loadDustState` + `loadDustCursor`.
   *
   * Absent means rebuild from scratch. Present means **resume**: only entries at or above the cursor are
   * fetched and applied, so nothing is re-derived and the successors a spend created stay exactly as the
   * builder left them. This is what stops a wallet losing DUST syncing the moment it pays a fee.
   */
  readonly resume?: {readonly state: DustStateBytes; readonly cursor: DustTreeCursor}
  /**
   * Spends already known for this wallet — `loadDustRepairs`. Each is replayed during the walk so its
   * successor is reinstated rather than the output dropped.
   *
   * ⚠️ **Pass the persisted list.** Discovery is sequential in `seq`: a successor's nullifier is built
   * from its own post-fee `initial_value` and the spend's `ctime`, so the *next* spend cannot be asked
   * about until the current successor exists. Starting from what is already known is what stops every
   * sync re-walking each output's whole history one rebuild at a time. Whatever comes back in
   * {@link DustSyncResult.repairs} should be persisted.
   */
  readonly repairs?: readonly DustSpendRepair[]
}

/**
 * One spend to replay, so its successor is reinstated rather than the output merely dropped.
 *
 * Replaying the chain's own event is the repair: `DustSpendProcessed` removes the spent output,
 * re-accrues its value to the declared time, subtracts the fee actually paid, derives the `seq + 1`
 * nonce and inserts the successor at `commitmentIndex`. Every one of those is a ledger rule this module
 * would otherwise have to restate.
 */
export type DustSpendRepair = {
  readonly nullifier: string
  /**
   * Where this transaction's DUST commitments begin. The tree is advanced to exactly here before the
   * batch is replayed.
   *
   * ⚠️ **Not the successor's index.** Which commitment in the range is the successor is not knowable
   * from the indexer, and requiring it is what dropped every split-change send's DUST (see
   * `readSpendReplayFromTransaction`). The ledger places each commitment itself.
   */
  readonly commitmentStart: number
  /** Exclusive end of the range; the commitment tree sits here once the batch has been replayed. */
  readonly commitmentEnd: number
  /**
   * The same range in the generation tree.
   *
   * ⚠️ **The batch moves both trees.** Positioning only the commitment tree makes the native replay
   * refuse the entire sync — `values inserted non-linearly into dust generation tree` — which is not a
   * recoverable per-spend failure but a wallet that cannot sync at all. Measured on a device.
   */
  readonly generationStart: number
  /** Exclusive end of the generation range. */
  readonly generationEnd: number
  /** Every DUST ledger event the spending transaction published, tagged-serialized, hex, in order. */
  readonly spendEvents: readonly string[]
}

/** Last write wins, which is also the order they were discovered in. */
const dedupeRepairs = (repairs: readonly DustSpendRepair[]): readonly DustSpendRepair[] => {
  const byNullifier = new Map<string, DustSpendRepair>()
  for (const repair of repairs) byNullifier.set(repair.nullifier.toLowerCase(), repair)
  return [...byNullifier.values()]
}

export const syncDust = (params: DustSyncParams): Effect.Effect<DustSyncResult, DustSyncError | DustIndexerError> =>
  Effect.gen(function* () {
    // ⚠️ **A spent wallet's rebuild discovers and repairs, it does not refuse.** A rebuild derives every
    // nonce from `seq 0` while a spend leaves a successor at `seq + 1` the per-address feed does not
    // carry. The chain does carry it, as the spending transaction's own `DustSpendProcessed` — but a
    // rebuild cannot ask for it until it holds the state that produces the nullifiers to ask about, and
    // a successor's nullifier depends on its own post-fee value and the spend's `ctime`. So each round
    // advances every output's history by exactly one step, and the rounds recurse until nothing new
    // turns up. Passing the persisted list in is what keeps that at one round in the steady state.
    const known = dedupeRepairs(params.repairs ?? [])
    /** Spends found this round that `known` did not carry — what the next sync should start from. */
    let discovered: readonly DustSpendRepair[] = []

    // Both trees are filled in index order, and each insert must land exactly at `first_free`. On a
    // resume these come from the stored cursor, which is the whole difference between advancing a state
    // and rebuilding one.
    let state = params.resume?.state ?? (yield* nativeStep(() => dustStateNew()))
    let nextGeneration = params.resume?.cursor.nextGeneration ?? 0
    let nextCommitment = params.resume?.cursor.nextCommitment ?? 0
    let collapses = 0

    // ⚠️ **From 0, even on an advance.** The subscription filters by generation index, and a dtime
    // update lands on an *older* leaf — the one whose backing NIGHT just moved — so starting at the
    // cursor would never deliver it. This feed is per address and tiny (single digits for a real
    // wallet), so reading it whole costs nothing; what the cursor decides is which items get
    // **inserted**, below.
    const feed = yield* fetchGenerationEntries(params.indexerUrl, params.dustAddress, 0, params.searchTo ?? 4_000_000)
    const resumeFrom = nextGeneration
    const entries = feed.entries.filter((entry) => entry.generationIndex >= resumeFrom)
    logger.info('dust sync read this address entries', {
      origin: ORIGIN,
      entries: entries.length,
      skippedBelowCursor: feed.entries.length - entries.length,
      dtimeUpdates: feed.dtimeUpdates.length,
      mode: params.resume === undefined ? 'rebuild' : 'advance',
      fromGeneration: resumeFrom,
    })

    // ⚠️ **One pass over both kinds of stop, ordered by commitment index.** A repair has no generation
    // index and touches only the commitment tree; an entry touches both. Both insert at `first_free`,
    // so a single ascending walk is the only order in which either is legal — and interleaving is not
    // optional, because a repair's index sits *below* our later entries. Applying repairs afterwards
    // cannot work: the tree has already been advanced past them and there is no going back.
    /**
     * ⚠️ **An entry inside a repair's range is written by the replay, not by us.**
     *
     * A repair replays its transaction's whole event batch, which writes every commitment in
     * `[commitmentStart, commitmentEnd)` — and for a self-funded send those are the successor *plus the
     * new NIGHT change outputs*, which the per-address feed also reports as our entries. Inserting them
     * again would refuse as `unordered-feed`, because the batch has already advanced the tree past
     * them. So the range wins and the feed's copies are dropped, counted rather than silently.
     */
    const coveredByRepair = (entry: {readonly commitmentIndex: number; readonly generationIndex: number}): boolean =>
      known.some(
        (one) =>
          (entry.commitmentIndex >= one.commitmentStart && entry.commitmentIndex < one.commitmentEnd) ||
          (entry.generationIndex >= one.generationStart && entry.generationIndex < one.generationEnd),
      )
    const feedEntries = entries.filter((entry) => !coveredByRepair(entry))
    if (feedEntries.length !== entries.length) {
      logger.debug('some feed entries fall inside a repair’s commitment range and are left to its replay', {
        origin: ORIGIN,
        covered: entries.length - feedEntries.length,
        repairs: known.length,
      })
    }

    const steps: readonly (
      | {readonly kind: 'entry'; readonly commitmentIndex: number; readonly entry: (typeof entries)[number]}
      | {readonly kind: 'repair'; readonly commitmentIndex: number; readonly repair: DustSpendRepair}
    )[] = [
      ...feedEntries.map((entry) => ({kind: 'entry' as const, commitmentIndex: entry.commitmentIndex, entry})),
      ...known.map((repair) => ({
        kind: 'repair' as const,
        commitmentIndex: repair.commitmentStart,
        repair,
      })),
    ].sort((a, b) => a.commitmentIndex - b.commitmentIndex)
    let repaired = 0

    for (const step of steps) {
      if (step.kind === 'repair') {
        if (step.commitmentIndex < nextCommitment) {
          return yield* new DustSyncError({
            cause: 'unordered-feed',
            reason: `a dust spend's successor at commitment ${step.commitmentIndex} sits behind the tree (${nextCommitment}), so it can no longer be reinstated`,
          })
        }
        if (step.commitmentIndex > nextCommitment) {
          const update = yield* fetchCommitmentUpdate(params.indexerUrl, nextCommitment, step.commitmentIndex - 1)
          if (update === null) {
            return yield* new DustSyncError({
              cause: 'missing-update',
              reason: `the indexer has no commitment update for ${nextCommitment}..${step.commitmentIndex - 1}, so this wallet cannot reach its own successor`,
            })
          }
          state = yield* nativeStep(() => dustApplyCommitmentCollapsedUpdate(state, update.update))
          collapses += 1
        }
        // The generation tree has to stand exactly where the batch expects too — the failure mode for
        // getting this wrong is not a skipped repair but a sync that refuses outright.
        if (step.repair.generationStart < nextGeneration) {
          return yield* new DustSyncError({
            cause: 'unordered-feed',
            reason: `a dust spend's generations start at ${step.repair.generationStart}, behind the tree (${nextGeneration}), so it can no longer be replayed`,
          })
        }
        if (step.repair.generationStart > nextGeneration) {
          const update = yield* fetchGenerationUpdate(
            params.indexerUrl,
            nextGeneration,
            step.repair.generationStart - 1,
          )
          if (update === null) {
            return yield* new DustSyncError({
              cause: 'missing-update',
              reason: `the indexer has no generation update for ${nextGeneration}..${step.repair.generationStart - 1}, so this wallet cannot reach its own successor`,
            })
          }
          state = yield* nativeStep(() => dustApplyGenerationCollapsedUpdate(state, update.update))
          collapses += 1
        }
        // ⚠️ **The transaction's whole event list, in one batch.** `dustReplayEvents` is upstream's own
        // path and keeps generations, commitments, nullifiers and dtime updates consistent together, so
        // it is the thing that knows which commitment in the range is the successor — this module never
        // has to. Feeding it a single event out of a transaction that published several would leave the
        // tree short of `commitmentEnd` and the next step would refuse as unordered.
        state = yield* nativeStep(() =>
          dustReplayEvents(state, params.dustRoleKey, step.repair.spendEvents.map(hexToBytes)),
        )
        // The ranges are where the trees now stand: the batch wrote every index in both.
        nextCommitment = step.repair.commitmentEnd
        nextGeneration = step.repair.generationEnd
        repaired += 1
        continue
      }
      const entry = step.entry
      if (entry.generationIndex < nextGeneration || entry.commitmentIndex < nextCommitment) {
        // Out of order, or a duplicate. Refusing beats inserting: the ledger would reject it, and
        // skipping it silently would drop money from the balance.
        return yield* new DustSyncError({
          cause: 'unordered-feed',
          reason: `dust entry ${entry.generationIndex}/${entry.commitmentIndex} arrived behind the trees (${nextGeneration}/${nextCommitment}) — the indexer's feed is not ordered`,
        })
      }
      if (entry.generationIndex > nextGeneration) {
        const update = yield* fetchGenerationUpdate(params.indexerUrl, nextGeneration, entry.generationIndex - 1)
        if (update === null) {
          return yield* new DustSyncError({
            cause: 'missing-update',
            reason: `the indexer has no generation update for ${nextGeneration}..${entry.generationIndex - 1}, so this wallet cannot reach its own entry`,
          })
        }
        state = yield* nativeStep(() => dustApplyGenerationCollapsedUpdate(state, update.update))
        collapses += 1
      }
      if (entry.commitmentIndex > nextCommitment) {
        const update = yield* fetchCommitmentUpdate(params.indexerUrl, nextCommitment, entry.commitmentIndex - 1)
        if (update === null) {
          return yield* new DustSyncError({
            cause: 'missing-update',
            reason: `the indexer has no commitment update for ${nextCommitment}..${entry.commitmentIndex - 1}, so this wallet cannot reach its own output`,
          })
        }
        state = yield* nativeStep(() => dustApplyCommitmentCollapsedUpdate(state, update.update))
        collapses += 1
      }

      state = yield* nativeStep(() => dustApplyGeneration(state, params.dustRoleKey, entry))
      nextGeneration = entry.generationIndex + 1
      nextCommitment = entry.commitmentIndex + 1
    }
    if (repaired > 0) {
      logger.info('reinstated the successors of dust outputs the chain had spent', {
        origin: ORIGIN,
        repaired,
        of: known.length,
      })
    }

    // ⚠️ **Take the chain's own generation leaf wherever it published one, rather than reconstructing
    // it.** `treeInsertionPath` carries `(HashOutput, DustGenerationInfo)` — the leaf itself — and
    // `update_from_evidence` installs it verbatim.
    //
    // Measured 2026-08-23 on a wallet with 45 entries and 43 dtime updates: the **commitment** root
    // matched the chain while the **generation** root did not. A commitment leaf is
    // `{initial_value, owner, nonce, ctime}`, so those four are right; the fields that appear only in a
    // generation leaf are `value` and `dtime`, and one of them is reconstructed wrong. Rather than find
    // out which and fix our construction of it, this stops constructing the leaf at all wherever the
    // chain has told us what it is — 43 of 45 leaves here.
    //
    // ⚠️ **After the inserts, not before.** `update_from_evidence` replaces a leaf that is already in
    // the tree; on a rebuild nothing is there yet when the feed is read. The earlier version ran this
    // first and so could only ever help an advance.
    for (const dtimeUpdate of feed.dtimeUpdates) {
      state = yield* nativeStep(() => dustApplyDtimeUpdate(state, dtimeUpdate.treeInsertionPath))
    }
    if (feed.dtimeUpdates.length > 0) {
      logger.debug('took the chain own generation leaves where it published them', {
        origin: ORIGIN,
        leaves: feed.dtimeUpdates.length,
      })
    }

    // ⚠️ **This state has no `sync_time`, so it can be read but never spent from.** A DUST spend proof
    // commits to these trees' roots and the node looks them up under the timestamp the spend declares
    // (`root_history.get(ctime)`); only event replay advances `sync_time`, and nothing here replays.
    // Collapsed updates carry `startIndex`/`endIndex`/`update`/`protocolVersion` and no block time, so
    // the roots this builds belong to no nameable instant.
    //
    // Replaying the *tail* was tried and does not work: there is no tail. The events that would set the
    // time are the ones **below** the tip, covering the range this collapsed over — so the fix is the
    // planner's shape (`./dust-sync-plan.ts`, collapse below `firstRelevant` then replay from there),
    // which needs a way to map a generation index to an event id. `docs/DUST_SPEND_PROOF.md` has the
    // measurement; `send-self-funded.ts` refuses up front rather than building a proof the node rejects.
    // ⚠️ **A measurement, not a feature.** The trees are collapsed forward to the tip and the roots are
    // compared against the ones that block published, because that is what decides whether a
    // collapse-built state can ever be spent from: a spend proof commits to these roots and the node
    // looks its own up under the declared `ctime`. Equal roots put the fault in the timestamp; different
    // roots put it in how this sync builds the tree. `docs/DUST_SPEND_PROOF.md`.
    //
    // ⚠️ **Collapse forward to the tip, and keep the block time that tree belongs to.**
    //
    // A spend proof commits to these trees' roots and the node looks its own up under the timestamp the
    // spend declares (`root_history.get(ctime)`); a miss is reported as a bad proof rather than an
    // unknown time. Stopping at our own last entry leaves a tree that is the chain's only if our leaf
    // happened to be the last inserted in its block, so the remaining range is collapsed and the tip
    // block's timestamp becomes the `ctime` a spend can declare.
    //
    // ⚠️ Not the ruled-out "replay the tail" — there are no *events* past the tip. This is the
    // collapsed-update mechanism, which moves `first_free` to `end + 1`.
    //
    // ⚠️ Both end indices are **exclusive**: the last leaf is `end - 1`. Asking for `end` itself fails
    // as "attempted update on updated sub-tree", which reads like a refusal of forward collapsing
    // rather than of one index past the end.
    //
    // ⚠️ **The root comparison is back, and pinned this time.** It was removed because its verdict was
    // wrong before a send the node accepted — but that comparison was against the *current* tip, which
    // only corresponds to our end index while the tree has not moved, so a mismatch said nothing.
    // Pinned to the block this state was collapsed to, it says exactly one thing, and it is the thing
    // that matters: a spend proof carries these roots and the node resolves them under the ctime we
    // declare, so a state whose roots are not that block's produces a transaction the chain refuses as
    // `Custom error: 170` every single time.
    //
    // Measured 2026-09-06: this wallet's generation root was not any of the chain's over 3,000 blocks,
    // while every leaf it owns matched — the walk fetches ~120 collapsed ranges across 213 seconds and
    // a generation leaf is *mutable* (a dtime update replaces it), so ranges collapsed early are stale
    // by the end and the result belongs to no block at all. Every self-funded send was being built,
    // approved, refused on chain and silently re-sent through the sponsor.
    //
    // The real repair is to pin the whole walk to one block rather than to check it afterwards; until
    // that lands this at least stops the wallet promising DUST it cannot spend.
    //
    // All of it is best-effort. The balance is correct with or without a block time, and only
    // self-funding needs one — so a failure here leaves `blockTimeSecs` at 0, which keeps
    // `decideFeePayer` honest: no block time, no promise to pay.
    let blockTimeSecs = 0
    let collapsedAtHeight = 0
    // ⚠️ **A wallet with no DUST output has nothing to collapse for.** These roots are consumed by
    // exactly one thing — a spend proof — so a state with no spendable output can neither use them
    // nor be harmed by their absence, and `decideFeePayer` already refuses on `blockTimeSecs === 0`.
    // Running it anyway cost two indexer fetches and a native apply every tick, and logged the
    // mismatch at `error` every 90 s for the life of a wallet that had never registered for DUST —
    // burying the errors that do mean something. The underlying repair (pin the whole walk to one
    // block) is unchanged and still open; this only stops asking the question where no answer can
    // matter.
    const held = yield* nativeStep(() => spendableDustAt(state, params.atUnixSecs))
    const tip = held.utxos === 0 ? null : yield* Effect.either(fetchDustTreeTip(params.indexerUrl))
    if (tip === null) {
      logger.debug('no dust output to spend, so the trees are not collapsed forward', {origin: ORIGIN})
    } else if (tip._tag === 'Left') {
      logger.warn('could not read the DUST tree tip, so this state gets no block time', {
        origin: ORIGIN,
        error: tip.left.reason,
      })
    } else {
      const collapsed = yield* Effect.either(
        Effect.gen(function* () {
          let next = state
          const lastGeneration = tip.right.generationEndIndex - 1
          const lastCommitment = tip.right.commitmentEndIndex - 1
          if (lastGeneration >= nextGeneration) {
            const update = yield* fetchGenerationUpdate(params.indexerUrl, nextGeneration, lastGeneration)
            if (update === null) return null
            next = yield* nativeStep(() => dustApplyGenerationCollapsedUpdate(next, update.update))
          }
          if (lastCommitment >= nextCommitment) {
            const update = yield* fetchCommitmentUpdate(params.indexerUrl, nextCommitment, lastCommitment)
            if (update === null) return null
            next = yield* nativeStep(() => dustApplyCommitmentCollapsedUpdate(next, update.update))
          }
          // ⚠️ The cursor has to follow the collapse, not just the inserts. A collapsed range is
          // *materialised*: asking for it again fails with "attempted update on updated sub-tree", so a
          // cursor left behind would make every later advance fail on its first query.
          return {state: next, nextGeneration: lastGeneration + 1, nextCommitment: lastCommitment + 1}
        }),
      )
      if (collapsed._tag === 'Left') {
        logger.warn('the DUST trees could not be collapsed forward to the tip, so this state cannot pay a fee', {
          origin: ORIGIN,
          tipHeight: tip.right.blockHeight,
          generationRange: `${nextGeneration}..${tip.right.generationEndIndex - 1}`,
          commitmentRange: `${nextCommitment}..${tip.right.commitmentEndIndex - 1}`,
          // ⚠️ `reason`, not `String(error)`: these are `Data.TaggedError`s, whose `message` is empty
          // and whose `toString` is the bare tag.
          error: collapsed.left.reason,
          failure: collapsed.left._tag,
        })
      } else if (collapsed.right === null) {
        logger.warn('the indexer had no collapsed update for the tail, so this state gets no block time', {
          origin: ORIGIN,
          tipHeight: tip.right.blockHeight,
        })
      } else {
        state = collapsed.right.state
        nextGeneration = collapsed.right.nextGeneration
        nextCommitment = collapsed.right.nextCommitment
        // ⚠️ Pinned to `tip.right`, the block we just collapsed to — never to a freshly-read tip, which
        // is what made the old comparison meaningless.
        const roots = yield* Effect.either(Effect.promise(() => dustTreeRoots(state)))
        // The tag prefix is 32 ASCII bytes, so 64 hex characters; the indexer publishes only the payload.
        const payload = (root: string | null): string | null => (root === null ? null : root.slice(64))
        const matches =
          roots._tag === 'Right' &&
          payload(roots.right.generation) === tip.right.generationRoot &&
          payload(roots.right.commitment) === tip.right.commitmentRoot
        if (!matches) {
          // ⚠️ **`blockTimeSecs` deliberately stays 0.** That is this file's existing signal for "this
          // state cannot pay a fee", and `decideFeePayer` already refuses on it by name. Reusing it
          // beats inventing a second flag that every caller would have to learn.
          logger.error('the DUST trees do not match the chain at the block they were collapsed to', {
            origin: ORIGIN,
            tipHeight: tip.right.blockHeight,
            generation:
              roots._tag === 'Right' && payload(roots.right.generation) === tip.right.generationRoot
                ? 'matches'
                : 'DIFFERS',
            commitment:
              roots._tag === 'Right' && payload(roots.right.commitment) === tip.right.commitmentRoot
                ? 'matches'
                : 'DIFFERS',
          })
        } else {
          blockTimeSecs = tip.right.blockTimeSecs
          collapsedAtHeight = tip.right.blockHeight
        }
        logger.debug('collapsed the DUST trees forward to the tip', {
          origin: ORIGIN,
          tipHeight: tip.right.blockHeight,
          blockTimeSecs,
        })
      }
    }

    // ⚠️ **Ask the chain which of these outputs it has already spent, and drop those.**
    //
    // `dust-spent` records what *this app* did. A wallet whose DUST was spent by a `harness/` run,
    // another device or a dApp carries no flag, so the state above holds outputs the chain retired: a
    // spend of one proves fine and is refused at submit with `196 — DustDoubleSpend`, and until then its
    // value inflates the balance. Observed on device 2026-08-23.
    //
    // ⚠️ This **drops** them rather than recovering their value. Rebuilding each successor needs the
    // spending transaction's fee and commitment index — `docs/DUST_SPEND_PROOF.md` §196. Dropping is the
    // half that stops selection building a doomed proof and stops the balance lying.
    //
    // Best-effort: an unreachable indexer must not fail a sync that otherwise produced a good state, so
    // the failure is logged and the outputs stay. The next tick asks again.
    const nullifiers = yield* Effect.either(
      Effect.gen(function* () {
        const ours = yield* nativeStep(() => dustNullifiers(state, params.dustRoleKey))
        if (ours.length === 0) return []
        const spent = yield* fetchSpentNullifiers(params.indexerUrl, ours)
        return spent
      }),
    )
    if (nullifiers._tag === 'Left') {
      // ⚠️ For a wallet that has spent, this is not recoverable. Everywhere else the outputs merely stay
      // and the next tick asks again; here the answer is what decides which of them are phantoms, and
      // returning the state would hand back `seq 0` outputs the chain has retired.
      if (params.spentDustBefore || known.length > 0) {
        return yield* new DustSyncError({
          cause: 'spent-before',
          reason:
            'this wallet has spent DUST and the chain could not be asked which outputs, so a rebuild ' +
            `cannot be repaired and must not be returned: ${nullifiers.left.reason}`,
        })
      }
      logger.warn('could not check which dust outputs the chain has spent; they stay in this state', {
        origin: ORIGIN,
        error: nullifiers.left.reason,
        failure: nullifiers.left._tag,
      })
    } else if (nullifiers.right.length > 0) {
      const spent = nullifiers.right
      const repairable = spent.flatMap((one) =>
        one.commitmentStart === undefined ||
        one.commitmentEnd === undefined ||
        one.generationStart === undefined ||
        one.generationEnd === undefined ||
        one.spendEvents.length === 0
          ? []
          : [
              {
                nullifier: one.nullifier,
                commitmentStart: one.commitmentStart,
                commitmentEnd: one.commitmentEnd,
                generationStart: one.generationStart,
                generationEnd: one.generationEnd,
                spendEvents: one.spendEvents,
              },
            ],
      )
      // Only what `known` did not already carry: everything else is already in the state, and
      // re-reporting it would make the caller believe a step remained for ever.
      const seen = new Set(known.map((one) => one.nullifier.toLowerCase()))
      const fresh = repairable.filter((one) => !seen.has(one.nullifier.toLowerCase()))
      // ⚠️ **One step per sync, and the state returned is usable at every step.** A spend proof commits
      // to the tree *roots*, and a successor we have not reinstated is covered by a collapsed update
      // whose hash is the chain's own — so the roots are right whatever the repair depth. Reinstating
      // recovers an output's *value*; it is not what makes the state spendable. Proven 2026-08-23: a
      // send from a state with only the first step reinstated landed on chain.
      //
      // So this does not recurse. It reports what is left, the caller persists the list, and the next
      // tick takes the next step — which keeps every sync bounded, makes progress survive an
      // interruption, and never blocks the wallet behind a backlog it did not create.
      discovered = fresh
      if (fresh.length > 0) {
        logger.info('there are dust spends one step further along, for the next sync to reinstate', {
          origin: ORIGIN,
          fresh: fresh.length,
          known: known.length,
        })
      }
      if (repairable.length < spent.length) {
        // These published no unambiguous commitment index or spend event, so they can never be
        // reinstated. Dropping them is correct and permanent: their value is gone, but they can no
        // longer produce a proof the node refuses with `196`.
        logger.warn('some spent dust outputs can never be reinstated and are dropped instead', {
          origin: ORIGIN,
          repairable: repairable.length,
          unrepairable: spent.length - repairable.length,
        })
      }
      state = yield* nativeStep(() =>
        dustRemoveUtxos(
          state,
          spent.map((one) => hexToBytes(one.nullifier)),
        ),
      )
      logger.info('dropped dust outputs the chain has already spent', {
        origin: ORIGIN,
        dropped: spent.length,
        // The successors' commitments, which a repair needs to rebuild the value rather than lose it.
        commitments: spent.map((one) => one.commitment),
      })
    }

    const balance = yield* nativeStep(() => spendableDustAt(state, params.atUnixSecs))
    logger.info('dust sync finished', {
      stateSyncTime: balance.syncTime,
      origin: ORIGIN,
      entries: entries.length,
      collapses,
      bytes: state.length,
      balance: balance.balance.toString(),
      utxos: balance.utxos,
      // Two different clocks: the native state's own, which only a replay advances, and the block whose
      // roots this state's trees now match. Conflating them is what made this subject confusing.
      blockTimeSecs,
    })
    return {
      state,
      cursor: {nextGeneration, nextCommitment},
      repairs: [...known, ...discovered],
      moreToRepair: discovered.length > 0,
      collapsedAtHeight,
      entries: entries.length,
      collapses,
      balance,
      syncTimeSecs: blockTimeSecs,
    }
  })
