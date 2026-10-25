/**
 * The indexer surfaces a DUST sync needs, as they actually exist on the live v4 API.
 *
 * Split from `./dust-sync.ts` so the transport is testable against a fake and the sync loop stays about
 * ordering. Every shape here was read from the live preprod schema by introspection rather than from
 * documentation, because two of the four are easy to look for in the wrong place:
 *
 * | what | where | gives |
 * |---|---|---|
 * | `dustLedgerEvents(id)` | **Subscription** | `{id, raw, maxId, protocolVersion}` — `raw` is the tagged `Event` the native replay consumes, and **`maxId` is the tip**, so no separate tip query is needed |
 * | `dustGenerations(dustAddress, startIndex, endIndex)` | **Subscription** | per-address items plus a `DustGenerationsProgress` carrying `highestIndex` |
 * | `dustGenerationMerkleTreeUpdate(startIndex, endIndex)` | ⚠️ **Query**, not Subscription | one `{startIndex, endIndex, update, protocolVersion}` collapsed blob |
 * | `dustCommitmentMerkleTreeUpdate(startIndex, endIndex)` | ⚠️ **Query** | the same, for the commitment tree |
 *
 * ⚠️ The last two being `Query` fields matters: the subscription list reads as complete without them, so
 * a reader can conclude the only route is a full event replay — which is exactly the conclusion that
 * makes a first DUST sync cost hours.
 *
 * @module
 */

import type {DustGenerationEntry} from '@pnyx/midnight-native'
import {Data, Effect} from 'effect'

import {logger} from '../../../logger'
import {indexerAuthHeaders} from '../indexer-auth'
import {
  anchorKindFor,
  type GenerationsAnchor,
  generationsQuery,
  generationsSubscription,
} from './dust-generations-query'
import {dustGenerationsShapeFor, unsupportedShapeReason} from './dust-indexer-capability'
import {runSubscription, type Verdict} from './graphql-ws'
import {indexerWsUrl} from './unshielded-sync'

/**
 * The indexer could not be read.
 *
 * ⚠️ `cause` is load-bearing for the fast sync. `graphql` and `malformed` mean the indexer answered but
 * this wallet cannot use the answer — preprod's public indexer was reported serving *gapped* generation
 * feeds on 2026-08-21, which is unusable by any wallet driving the same crate. `http` is the ordinary
 * "could not reach it", which a retry may survive. Collapsing the three loses the one distinction that
 * says whether to retry or to report the indexer as broken.
 */
export class DustIndexerError extends Data.TaggedError('DustIndexerError')<{
  /**
   * `unsupported` is this indexer serving a `dustGenerations` shape the sync does not implement —
   * a version difference, not a fault. Distinguished so a caller can stop retrying: the old shape
   * failed as `graphql` on every scheduled tick, forever, which buries real failures in noise.
   */
  readonly cause: 'http' | 'graphql' | 'malformed' | 'unsupported'
  /**
   * Whether asking again could answer differently — a gateway failure or a dropped connection, never
   * the indexer's own verdict. Absent means no, so only the paths that know they hit the network set
   * it.
   */
  readonly retryable?: boolean
  readonly reason: string
}> {}

/**
 * Which anchor this indexer's `dustGenerations` takes, with the values to fill it.
 *
 * ⚠️ Probed, never inferred from the network name — see `dust-indexer-capability.ts` for why. A probe
 * that could not answer falls back to the index range rather than refusing: an introspection outage
 * must not stop a sync that would otherwise have worked, and a wrong shape fails loudly by itself.
 *
 * The block anchor is taken **fresh** on every read, because the indexer refuses a block older than
 * its `max_snapshot_age` and that limit is not in the schema — see `./dust-generations-query.ts`.
 */
const generationsAnchorFor = (
  indexerUrl: string,
  window: {readonly start: number; readonly end: number},
): Effect.Effect<GenerationsAnchor, DustIndexerError> =>
  Effect.gen(function* () {
    const shape = yield* dustGenerationsShapeFor(indexerUrl, (url) =>
      post<Record<string, unknown>>(url, INTROSPECT_DUST_GENERATIONS, {}),
    )
    if (shape !== null && shape.kind === 'unrecognised') {
      return yield* new DustIndexerError({cause: 'unsupported', reason: unsupportedShapeReason(shape)})
    }
    const kind = shape === null ? 'index-range' : anchorKindFor(shape)
    if (kind === null || kind === 'index-range') return {kind: 'index-range', start: window.start, end: window.end}
    const anchor = yield* fetchBlockAnchor(indexerUrl)
    return {kind, blockHash: anchor.hash, blockHeight: anchor.height}
  })

/**
 * The latest block's hash and height — the anchor a block-pinned generation snapshot needs.
 *
 * Separate from {@link fetchDustTreeTip}, which reads the DUST tree fields off a block and does not
 * carry its hash. Kept minimal on purpose: this is on the path of every generation read under the
 * newer shape.
 */
const fetchBlockAnchor = (url: string): Effect.Effect<{hash: string; height: number}, DustIndexerError> =>
  post<{block?: unknown}>(url, `query BlockAnchor { block { hash height } }`, {}).pipe(
    Effect.flatMap((data) => {
      const row = data.block as {hash?: unknown; height?: unknown} | null | undefined
      if (row === null || row === undefined || typeof row.hash !== 'string' || typeof row.height !== 'number') {
        return Effect.fail(
          new DustIndexerError({cause: 'malformed', reason: 'the tip block carried no hash and height'}),
        )
      }
      return Effect.succeed({hash: row.hash, height: row.height})
    }),
  )

const INTROSPECT_DUST_GENERATIONS = `query DustGenerationsArgs {
  __schema { subscriptionType { fields { name args { name } } } }
}`

const ORIGIN = 'dust-indexer'

const fromHex = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** One collapsed update: the bytes plus the range it advances a tree across. */
export type CollapsedUpdate = {
  readonly startIndex: number
  readonly endIndex: number
  readonly update: Uint8Array
  readonly protocolVersion: number
}

const UPDATE_FIELDS = 'startIndex endIndex update protocolVersion'

/**
 * How many times a gateway failure is retried before the walk gives up on that range.
 *
 * ⚠️ **A gateway error is not an answer.** Preview's `dustCommitmentMerkleTreeUpdate` was measured at a
 * ~50% `502` rate on 2026-09-06 — eight calls to one range came back four ok and four `502`, and the
 * same range answered differently seconds apart. A rebuild makes ~100 of these calls, so without a
 * retry it never finishes and the first failure reads as "the indexer responded 502", which sounds
 * like a verdict about our request rather than a coin toss.
 *
 * Only 5xx and transport failures are retried. A GraphQL error or a 4xx is the indexer telling us
 * something true, and repeating the question does not change the answer.
 */
const GATEWAY_ATTEMPTS = 4

const post = <T>(url: string, query: string, variables: Record<string, unknown>): Effect.Effect<T, DustIndexerError> =>
  postOnce<T>(url, query, variables).pipe(
    Effect.retry({
      times: GATEWAY_ATTEMPTS - 1,
      while: (error: DustIndexerError) => error.cause === 'http' && error.retryable === true,
    }),
  )

const postOnce = <T>(
  url: string,
  query: string,
  variables: Record<string, unknown>,
): Effect.Effect<T, DustIndexerError> =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(url, {
          method: 'POST',
          headers: {'Content-Type': 'application/json', ...indexerAuthHeaders(url)},
          body: JSON.stringify({query, variables}),
        }),
      // A transport failure never reached the indexer, so it is worth asking again.
      catch: (error) => new DustIndexerError({cause: 'http', reason: String(error), retryable: true}),
    })
    if (!response.ok) {
      return yield* new DustIndexerError({
        cause: 'http',
        reason: `the indexer responded ${response.status}`,
        // 5xx is the gateway, not the question. A 4xx is the question.
        retryable: response.status >= 500,
      })
    }
    const reply = yield* Effect.tryPromise({
      try: () => response.json() as Promise<{data?: T; errors?: readonly {message: string}[]}>,
      catch: (error) => new DustIndexerError({cause: 'malformed', reason: String(error)}),
    })
    if (reply.errors !== undefined && reply.errors.length > 0) {
      return yield* new DustIndexerError({cause: 'graphql', reason: reply.errors.map((e) => e.message).join('; ')})
    }
    if (reply.data === undefined) {
      return yield* new DustIndexerError({cause: 'malformed', reason: 'the indexer returned no data'})
    }
    return reply.data
  })

const readUpdate = (raw: unknown, what: string): CollapsedUpdate | null | DustIndexerError => {
  if (raw === null || raw === undefined) {
    // A range the indexer has nothing to say about. `null` rather than an empty update, because
    // applying a fabricated one would advance a tree past leaves it had not seen.
    logger.debug('the indexer had no collapsed update for that range', {origin: ORIGIN, what})
    return null
  }
  const row = raw as {startIndex?: unknown; endIndex?: unknown; update?: unknown; protocolVersion?: unknown}
  if (
    typeof row.startIndex !== 'number' ||
    typeof row.endIndex !== 'number' ||
    typeof row.update !== 'string' ||
    typeof row.protocolVersion !== 'number'
  ) {
    return new DustIndexerError({cause: 'malformed', reason: `${what}: malformed collapsed update`})
  }
  return {
    startIndex: row.startIndex,
    endIndex: row.endIndex,
    update: fromHex(row.update),
    protocolVersion: row.protocolVersion,
  }
}

/**
 * Where both DUST trees end at the chain's tip, when that block was, and the roots it published.
 *
 * ⚠️ **`timestamp` is milliseconds** — the indexer returns `1787485992001` — while a spend's `ctime` is
 * seconds. Converted here so no caller can get it wrong: a `ctime` a thousand times too large misses
 * `root_history` and comes back as `InvalidDustSpendProof`, naming the proof rather than the time.
 *
 * ⚠️ **`generationEndIndex` and `commitmentEndIndex` are exclusive.** The last leaf is `end - 1`, and
 * asking a collapsed-update query for `end` itself fails as "attempted update on updated sub-tree",
 * which reads like a refusal of forward collapsing rather than of one index past the end.
 *
 * The roots are what make "is our tree the chain's tree?" a comparison instead of a guess —
 * `docs/DUST_SPEND_PROOF.md`.
 */
export type DustTreeTip = {
  readonly blockHeight: number
  readonly blockTimeSecs: number
  readonly generationEndIndex: number
  readonly commitmentEndIndex: number
  readonly generationRoot: string
  readonly commitmentRoot: string
}

export const fetchDustTreeTip = (url: string, atHeight?: number): Effect.Effect<DustTreeTip, DustIndexerError> =>
  post<{block?: unknown}>(
    url,
    // ⚠️ `atHeight` is what makes a root comparison mean anything. Without it the caller compares its
    // tree against whatever the tip is *now*, and preprod moves every few seconds — so a mismatch says
    // only that time passed. Pinning the block the state was collapsed to removes the race entirely.
    atHeight === undefined
      ? `query DustTip { block { height timestamp dustGenerationEndIndex dustCommitmentEndIndex dustGenerationMerkleTreeRoot dustCommitmentMerkleTreeRoot } }`
      : `query DustTipAt($height: Int!) { block(offset: {height: $height}) { height timestamp dustGenerationEndIndex dustCommitmentEndIndex dustGenerationMerkleTreeRoot dustCommitmentMerkleTreeRoot } }`,
    atHeight === undefined ? {} : {height: atHeight},
  ).pipe(
    Effect.flatMap((data) => {
      const row = data.block as
        | {
            height?: unknown
            timestamp?: unknown
            dustGenerationEndIndex?: unknown
            dustCommitmentEndIndex?: unknown
            dustGenerationMerkleTreeRoot?: unknown
            dustCommitmentMerkleTreeRoot?: unknown
          }
        | null
        | undefined
      if (
        row === null ||
        row === undefined ||
        typeof row.height !== 'number' ||
        typeof row.timestamp !== 'number' ||
        typeof row.dustGenerationEndIndex !== 'number' ||
        typeof row.dustCommitmentEndIndex !== 'number' ||
        typeof row.dustGenerationMerkleTreeRoot !== 'string' ||
        typeof row.dustCommitmentMerkleTreeRoot !== 'string'
      ) {
        return Effect.fail(
          new DustIndexerError({cause: 'malformed', reason: 'the tip block did not carry the DUST tree fields'}),
        )
      }
      return Effect.succeed({
        blockHeight: row.height,
        blockTimeSecs: Math.floor(row.timestamp / 1000),
        generationEndIndex: row.dustGenerationEndIndex,
        commitmentEndIndex: row.dustCommitmentEndIndex,
        generationRoot: row.dustGenerationMerkleTreeRoot,
        commitmentRoot: row.dustCommitmentMerkleTreeRoot,
      })
    }),
  )

/** A collapsed update for the **generation** tree across `[start, end]`. */
export const fetchGenerationUpdate = (
  url: string,
  start: number,
  end: number,
): Effect.Effect<CollapsedUpdate | null, DustIndexerError> =>
  post<{dustGenerationMerkleTreeUpdate?: unknown}>(
    url,
    `query GenUpdate($start: Int!, $end: Int!) { dustGenerationMerkleTreeUpdate(startIndex: $start, endIndex: $end) { ${UPDATE_FIELDS} } }`,
    {start, end},
  ).pipe(
    Effect.flatMap((data) => {
      const update = readUpdate(data.dustGenerationMerkleTreeUpdate, 'generation update')
      return update instanceof DustIndexerError ? Effect.fail(update) : Effect.succeed(update)
    }),
  )

/** A collapsed update for the **commitment** tree across `[start, end]`. */
export const fetchCommitmentUpdate = (
  url: string,
  start: number,
  end: number,
): Effect.Effect<CollapsedUpdate | null, DustIndexerError> =>
  post<{dustCommitmentMerkleTreeUpdate?: unknown}>(
    url,
    `query ComUpdate($start: Int!, $end: Int!) { dustCommitmentMerkleTreeUpdate(startIndex: $start, endIndex: $end) { ${UPDATE_FIELDS} } }`,
    {start, end},
  ).pipe(
    Effect.flatMap((data) => {
      const update = readUpdate(data.dustCommitmentMerkleTreeUpdate, 'commitment update')
      return update instanceof DustIndexerError ? Effect.fail(update) : Effect.succeed(update)
    }),
  )

/** One ledger DUST event, and the tip it reported. */
export type DustEvent = {
  readonly id: number
  readonly raw: Uint8Array
  readonly maxId: number
}

const EVENTS_QUERY = `subscription DustEvents($id: Int) {
  dustLedgerEvents(id: $id) {
    __typename
    id
    raw
    maxId
    protocolVersion
  }
}`

/**
 * Read up to `limit` DUST ledger events from `fromId`.
 *
 * Stops at `limit` or at the tip, whichever comes first, and returns what it got with the tip it saw.
 * Bounded rather than open-ended because the caller applies each batch natively and persists a
 * watermark between them: an unbounded read would hold every event of a 1.2M-event history in memory
 * before a single one had been applied.
 */
export const fetchDustEvents = (
  indexerUrl: string,
  fromId: number,
  limit: number,
): Effect.Effect<{readonly events: readonly DustEvent[]; readonly tip: number | null}, DustIndexerError> =>
  Effect.gen(function* () {
    const events: DustEvent[] = []
    let tip: number | null = null

    yield* Effect.tryPromise({
      try: () =>
        runSubscription<{dustLedgerEvents?: unknown}>({
          url: indexerWsUrl(indexerUrl),
          query: EVENTS_QUERY,
          variables: {id: fromId},
          onNext: (data): Verdict => {
            const row = data.dustLedgerEvents as {id?: unknown; raw?: unknown; maxId?: unknown} | null | undefined
            if (row === null || row === undefined) return 'continue'
            if (typeof row.maxId === 'number') tip = row.maxId
            if (typeof row.id !== 'number' || typeof row.raw !== 'string') {
              // A payload without an id or bytes cannot be applied and cannot advance the cursor. Skipped
              // rather than fatal — the tip it carried is still useful — but never silently.
              logger.warn('a dust ledger event arrived without id or raw bytes', {origin: ORIGIN, tip})
              return 'continue'
            }
            events.push({id: row.id, raw: fromHex(row.raw), maxId: tip ?? row.id})
            return events.length >= limit ? 'stop' : 'continue'
          },
        }),
      catch: (error) => new DustIndexerError({cause: 'http', reason: String(error)}),
    })

    logger.debug('read dust ledger events', {origin: ORIGIN, fromId, got: events.length, tip})
    return {events, tip}
  })

/**
 * Where this wallet's own DUST generation starts, and how high the generation tree goes.
 *
 * `firstRelevant` is `null` when the address has no generation entries at all — the case that lets a
 * sync collapse the whole history. It is deliberately not `0`: see `dust-sync-plan.ts`.
 *
 * ⚠️ `startIndex`/`endIndex` here index the **global** generation tree, not this address's own entries.
 * A previous session scanned `0..50_000`, found nothing, and concluded the address held no DUST — while
 * its entries sat above 238,000. A wrong window and a true zero are indistinguishable, so the caller
 * passes the tree tip and not a guess.
 */
export const fetchGenerationRange = (
  indexerUrl: string,
  dustAddress: string,
  startIndex: number,
  endIndex: number,
): Effect.Effect<{readonly firstRelevant: number | null; readonly highestIndex: number | null}, DustIndexerError> =>
  Effect.gen(function* () {
    const anchor = yield* generationsAnchorFor(indexerUrl, {start: startIndex, end: endIndex})
    // No dtime updates: this read only wants indices, and under the block anchor withholding them is
    // an argument rather than a matter of what is selected.
    const query = generationsQuery(anchor, dustAddress, false)
    let firstRelevant: number | null = null
    let highestIndex: number | null = null

    yield* Effect.tryPromise({
      try: () =>
        runSubscription<{dustGenerations?: unknown}>({
          url: indexerWsUrl(indexerUrl),
          query: generationsSubscription(
            query,
            `    ... on DustGenerationsItem { generationMtIndex commitmentMtIndex }
    ... on DustGenerationsProgress { highestIndex }`,
          ),
          variables: query.variables,
          onNext: (data): Verdict => {
            const row = data.dustGenerations as {generationMtIndex?: unknown; highestIndex?: unknown} | null | undefined
            if (row === null || row === undefined) return 'continue'
            if (typeof row.highestIndex === 'number') highestIndex = row.highestIndex
            if (typeof row.generationMtIndex === 'number') {
              firstRelevant =
                firstRelevant === null ? row.generationMtIndex : Math.min(firstRelevant, row.generationMtIndex)
            }
            return 'continue'
          },
        }),
      catch: (error) => new DustIndexerError({cause: 'http', reason: String(error)}),
    })

    logger.debug('read the dust generation range', {origin: ORIGIN, firstRelevant, highestIndex})
    return {firstRelevant, highestIndex}
  })

/**
 * This wallet's own generation entries, with their dtime updates folded in.
 *
 * The cheap read the whole fast sync rests on: for a real test wallet this is **34 items**, against the
 * 1.45M events a full replay would take.
 *
 * ⚠️ `startIndex`/`endIndex` index the **global** generation tree, not this address's own entries. A
 * previous session scanned `0..50_000`, found nothing, and concluded the address held no DUST — while
 * its entries sat above 238,000. A wrong window and a true zero are indistinguishable, so the window is
 * deliberately wide and its upper bound is the caller's to justify.
 *
 * ⚠️ **`seq` is assumed to be 0**, which is right for an output that has never been spent. Spending DUST
 * produces a *successor* output at a higher `seq`, and this per-address feed does not carry successors —
 * so a wallet that has already spent DUST needs the event-replay path instead. Stated rather than
 * silently wrong: a bad `seq` derives a different nonce, so the output would be unspendable rather than
 * merely mis-numbered.
 *
 * ⚠️ **No progress frame arrives on this subscription** — measured against live preprod, 34 items and 14
 * dtime updates but **zero** `DustGenerationsProgress`. So there is no tree tip to read here, and the
 * caller must not wait for one.
 */
/**
 * Which of our nullifiers the chain has already seen spent.
 *
 * ⚠️ **This is the question `dust-spent` cannot answer.** That flag records what this app did; a wallet
 * whose DUST was spent by a `harness/` run, another device or a dApp carries no flag, so the sync
 * rebuilds it at `seq 0` and the node refuses the spend with `196 — DustDoubleSpend` while the balance
 * counts DUST that is gone.
 *
 * ⚠️ **Full nullifiers, not short prefixes.** The argument is named for prefixes and privacy is the
 * reason, but this indexer is already asked for `dustGenerations(dustAddress: …)` on every sync — it
 * knows exactly which wallet is asking, so a shorter prefix would buy nothing here and cost exactness.
 * Revisit if the generation feed ever stops being per-address.
 *
 * `commitmentLeBytes` is returned with each match: it is the successor's commitment, and the input a
 * later repair needs to rebuild the output rather than merely drop it — `docs/DUST_SPEND_PROOF.md` §196.
 */
export type SpentDustOutput = {
  /** The nullifier, exactly as it was asked for. */
  readonly nullifier: string
  /** The successor's commitment, for a repair that rebuilds rather than drops. */
  readonly commitment: string
  readonly blockHeight: number
  readonly transactionId: number
  /**
   * Where in the commitment tree this transaction's DUST commitments begin, or `undefined` when the
   * transaction carried no range.
   *
   * ⚠️ **A range, not the successor's index — which is the whole point.** Nothing in this response says
   * which commitment in `[start, end)` is ours, and an earlier version therefore repaired only spends
   * that wrote exactly one. Change splitting makes that condition unsatisfiable, so every self-funded
   * send with split change had its successor dropped. The replay does not need the index: position the
   * tree at `start`, hand the ledger the transaction's whole event list, and it writes each commitment
   * where it belongs.
   */
  readonly commitmentStart: number | undefined
  /** Exclusive end of that range; the commitment tree sits here once the batch has been replayed. */
  readonly commitmentEnd: number | undefined
  /**
   * The same for the generation tree.
   *
   * ⚠️ **Both trees, or the replay is refused.** The batch inserts generations as well as commitments,
   * and positioning only the commitment tree makes the native replay reject the whole sync with
   * `values inserted non-linearly into dust generation tree` — measured on a device, 2026-09-01.
   */
  readonly generationStart: number | undefined
  /** Exclusive end of the generation range. */
  readonly generationEnd: number | undefined
  /**
   * Every DUST ledger event this transaction published, tagged-serialized, in the order the indexer
   * returned them.
   *
   * Replaying them *is* the repair: the ledger's own branch removes the spent output, re-accrues its
   * value to the spend's declared time, subtracts the fee it actually paid, derives the `seq + 1`
   * nonce and inserts the successor. Rebuilding those by hand would restate five ledger rules.
   *
   * ⚠️ **All of them, not only `DustSpendProcessed`.** `dustReplayEvents` is upstream's own path and
   * maintains generations, commitments, nullifiers and dtime updates *together*; feeding it one event
   * out of a transaction that published several leaves the tree short of `end`. The role key inside
   * replay is what decides which outputs are ours, so passing an event about somebody else is not a
   * leak of anything or a corruption of anything — it is how the global tree stays in step.
   */
  readonly spendEvents: readonly string[]
}

/**
 * The replay inputs a spend's transaction carries: where its DUST commitments begin and end, and every
 * event it published.
 *
 * ⚠️ **It deliberately does not identify the successor.** It used to, and only when the transaction
 * wrote exactly one commitment — a condition change splitting makes unsatisfiable, so every
 * self-funded send that split its change had its successor dropped as unrepairable and its DUST
 * orphaned. Measured on preprod 2026-09-01: five spends with ranges of 2, 3, 3, 10 and 10, all
 * dropped. The ledger already knows where each commitment goes; the repair's job is to put the tree at
 * `start` and let it replay.
 *
 * Exported for its own test — the shapes it has to survive are an absent `transaction`, a non-regular
 * one, a missing range, and an event list that is empty or holds no spend at all.
 */
export const readSpendReplayFromTransaction = (
  transaction: unknown,
  nullifier: string,
): {
  readonly commitmentStart: number | undefined
  readonly commitmentEnd: number | undefined
  readonly generationStart: number | undefined
  readonly generationEnd: number | undefined
  readonly spendEvents: readonly string[]
} => {
  const tx = transaction as Record<string, unknown> | null | undefined
  const absent = {
    commitmentStart: undefined,
    commitmentEnd: undefined,
    generationStart: undefined,
    generationEnd: undefined,
    spendEvents: [],
  }
  if (tx === null || tx === undefined) return absent
  const num = (value: unknown): number | undefined => (typeof value === 'number' ? value : undefined)
  const start = num(tx.dustCommitmentStartIndex)
  const end = num(tx.dustCommitmentEndIndex)
  const generationStart = num(tx.dustGenerationStartIndex)
  const generationEnd = num(tx.dustGenerationEndIndex)
  const rawEvents = Array.isArray(tx.dustLedgerEvents) ? tx.dustLedgerEvents : []
  const spendEvents = rawEvents.flatMap((one): readonly string[] => {
    if (typeof one !== 'object' || one === null) return []
    const raw = (one as Record<string, unknown>).raw
    return typeof raw === 'string' ? [raw] : []
  })
  // ⚠️ A transaction whose range this wallet cannot read, or that published nothing, is not repairable
  // — and saying so is the only way the caller can tell it apart from one it simply has not reached.
  if (
    start === undefined ||
    end === undefined ||
    generationStart === undefined ||
    generationEnd === undefined ||
    spendEvents.length === 0
  ) {
    logger.warn('a dust spend published no replayable range or events, so its successor cannot be reinstated', {
      origin: ORIGIN,
      nullifier,
      start,
      end,
      generationStart,
      generationEnd,
      events: spendEvents.length,
    })
  }
  return {commitmentStart: start, commitmentEnd: end, generationStart, generationEnd, spendEvents}
}

export const fetchSpentNullifiers = (
  indexerUrl: string,
  nullifiers: readonly string[],
): Effect.Effect<readonly SpentDustOutput[], DustIndexerError> =>
  Effect.gen(function* () {
    if (nullifiers.length === 0) return []
    const wanted = new Set(nullifiers.map((one) => one.toLowerCase()))
    const found = new Map<string, SpentDustOutput>()

    yield* Effect.tryPromise({
      try: () =>
        runSubscription<{dustNullifierTransactions?: unknown}>({
          url: indexerWsUrl(indexerUrl),
          query: `subscription Spent($prefixes: [HexEncoded!]!) {
  dustNullifierTransactions(nullifierLeBytesPrefixes: $prefixes) {
    nullifierLeBytes
    commitmentLeBytes
    blockHeight
    transactionId
    transaction {
      ... on RegularTransaction {
        dustCommitmentStartIndex
        dustCommitmentEndIndex
        dustGenerationStartIndex
        dustGenerationEndIndex
        dustLedgerEvents { __typename raw }
      }
    }
  }
}`,
          variables: {prefixes: nullifiers},
          onNext: (data): Verdict => {
            const row = data.dustNullifierTransactions as Record<string, unknown> | null | undefined
            if (row === null || row === undefined) return 'continue'
            const nullifier = typeof row.nullifierLeBytes === 'string' ? row.nullifierLeBytes.toLowerCase() : undefined
            if (nullifier === undefined) return 'continue'
            // A prefix match can belong to another wallet. Only what we asked about is ours to act on.
            if (!wanted.has(nullifier)) return 'continue'
            // ⚠️ **No placeholder for an absent field.** An earlier version substituted `''` and `0`
            // here, which reads as a valid commitment at block 0 — and a repair driven off that would
            // insert at index 0. A row missing any of them is not a spend we can act on, so it is
            // skipped by name instead.
            const commitment = typeof row.commitmentLeBytes === 'string' ? row.commitmentLeBytes : undefined
            const blockHeight = typeof row.blockHeight === 'number' ? row.blockHeight : undefined
            const transactionId = typeof row.transactionId === 'number' ? row.transactionId : undefined
            if (commitment === undefined || blockHeight === undefined || transactionId === undefined) {
              logger.warn('a spent-nullifier row was missing fields, so it cannot be repaired or dropped', {
                origin: ORIGIN,
                nullifier,
                hasCommitment: commitment !== undefined,
                hasBlockHeight: blockHeight !== undefined,
                hasTransactionId: transactionId !== undefined,
              })
              return 'continue'
            }
            found.set(nullifier, {
              nullifier,
              commitment,
              blockHeight,
              transactionId,
              ...readSpendReplayFromTransaction(row.transaction, nullifier),
            })
            return found.size === wanted.size ? 'stop' : 'continue'
          },
        }),
      catch: (error) => new DustIndexerError({cause: 'http', reason: String(error)}),
    })

    logger.debug('asked the chain which of this wallet dust outputs are spent', {
      origin: ORIGIN,
      asked: nullifiers.length,
      spent: found.size,
    })
    return [...found.values()]
  })

/**
 * A dtime update to a leaf **already in the tree**, with the evidence to apply it.
 *
 * ⚠️ Kept apart from the entries because the two need opposite treatment. A rebuild folds `newDtime`
 * into the leaf as it inserts it; an **advance** cannot re-insert a leaf that is already there, and has
 * to replace it — `dustApplyDtimeUpdate`, which is the ledger's own `update_from_evidence`.
 */
export type DustDtimeUpdate = {
  readonly generationIndex: number
  readonly newDtime: number
  /** The ledger's `TreeInsertionPath`, tagged, exactly as the indexer serialized it. */
  readonly treeInsertionPath: Uint8Array
}

/** What this address's generation feed carries: leaves to insert, and updates to leaves already there. */
export type DustGenerationFeed = {
  readonly entries: readonly DustGenerationEntry[]
  readonly dtimeUpdates: readonly DustDtimeUpdate[]
}

export const fetchGenerationEntries = (
  indexerUrl: string,
  dustAddress: string,
  startIndex: number,
  endIndex: number,
): Effect.Effect<DustGenerationFeed, DustIndexerError> =>
  Effect.gen(function* () {
    const anchor = yield* generationsAnchorFor(indexerUrl, {start: startIndex, end: endIndex})
    // The dtime updates are the point of this read — they are what turns an entry into a leaf the
    // native side can insert — so the block anchor must be told to withhold none of them.
    const query = generationsQuery(anchor, dustAddress, true)
    const items = new Map<number, DustGenerationEntry>()
    const dtimes = new Map<number, number>()
    const evidence = new Map<number, Uint8Array>()

    yield* Effect.tryPromise({
      try: () =>
        runSubscription<{dustGenerations?: unknown}>({
          url: indexerWsUrl(indexerUrl),
          query: generationsSubscription(
            query,
            `    ... on DustGenerationsItem {
      generationMtIndex
      commitmentMtIndex
      value
      initialValue
      backingNight
      ctime
    }
    ... on DustGenerationDtimeUpdateItem { generationMtIndex newDtime treeInsertionPath }`,
          ),
          variables: query.variables,
          onNext: (data): Verdict => {
            const row = data.dustGenerations as Record<string, unknown> | null | undefined
            if (row === null || row === undefined) return 'continue'
            const index = row.generationMtIndex
            if (typeof index !== 'number') return 'continue'

            if (row.newDtime !== undefined) {
              // Times cross as strings when they exceed 2^53; parsed rather than coerced.
              dtimes.set(index, Number(String(row.newDtime)))
              if (typeof row.treeInsertionPath === 'string') {
                evidence.set(index, fromHex(row.treeInsertionPath))
              } else {
                // An update we can fold into a fresh insert but never apply to a leaf already in the
                // tree. Worth saying: it is the difference between a rebuild and an advance working.
                logger.warn('a dust dtime update carried no tree insertion path', {origin: ORIGIN, index})
              }
              return 'continue'
            }
            if (
              typeof row.commitmentMtIndex !== 'number' ||
              typeof row.backingNight !== 'string' ||
              row.value === undefined ||
              row.initialValue === undefined ||
              row.ctime === undefined
            ) {
              // An item missing a field cannot be inserted, and inserting a guessed one would build an
              // unspendable output. Skipped loudly.
              logger.warn('a dust generation item was missing fields', {origin: ORIGIN, index})
              return 'continue'
            }
            items.set(index, {
              generationIndex: index,
              commitmentIndex: row.commitmentMtIndex,
              value: BigInt(String(row.value)),
              initialValue: BigInt(String(row.initialValue)),
              ctime: Number(row.ctime),
              seq: 0,
              backingNight: row.backingNight,
              dtime: null,
            })
            return 'continue'
          },
        }),
      catch: (error) => new DustIndexerError({cause: 'http', reason: String(error)}),
    })

    const entries = [...items.values()].map((entry) => {
      const dtime = dtimes.get(entry.generationIndex)
      return dtime === undefined ? entry : {...entry, dtime}
    })
    const dtimeUpdates = [...dtimes.entries()].flatMap(([generationIndex, newDtime]) => {
      const treeInsertionPath = evidence.get(generationIndex)
      return treeInsertionPath === undefined ? [] : [{generationIndex, newDtime, treeInsertionPath}]
    })
    logger.debug('read this wallet dust generation entries', {
      origin: ORIGIN,
      items: entries.length,
      dtimeUpdates: dtimes.size,
      withEvidence: dtimeUpdates.length,
    })
    return {entries, dtimeUpdates}
  })
