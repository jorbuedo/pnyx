/**
 * What to fetch next when syncing DUST, as a pure decision.
 *
 * Its own module because it is the half worth testing: `./dust-sync.ts` opens a socket and reaches the
 * native bridge, and getting a range wrong here is not a crash but a **silently wrong balance** — a
 * skipped range is chain history the wallet never revisits once its watermark has moved past it.
 *
 * ## The two surfaces this plans against, as the live indexer actually exposes them
 *
 * | | |
 * |---|---|
 * | `Subscription.dustLedgerEvents(id)` | the event stream `dustReplayEvents` consumes. Complete, and expensive: Preprod carries over 1.2M of them |
 * | `Query.dustGenerationMerkleTreeUpdate(startIndex, endIndex)` and `Query.dustCommitmentMerkleTreeUpdate(startIndex, endIndex)` | one `{startIndex, endIndex, update, protocolVersion}` blob that advances a tree across a range **without** its events |
 *
 * ⚠️ They are **`Query`** fields, not subscriptions — worth stating because the subscription list looks
 * complete without them and a reader can conclude the wallet has no choice but full replay.
 *
 * The plan is therefore: collapse the range below what this wallet cares about, replay from there. What
 * it "cares about" is the first index at which it holds anything — for a wallet that has never held
 * DUST that is the tip, so a first sync collapses everything and replays nothing.
 *
 * @module
 */

/** How many events to ask for in one replay batch. */
export const DUST_EVENT_BATCH = 512

export type DustSyncCursor = {
  /** Next generation-tree index this wallet has not accounted for. */
  readonly generationIndex: number
  /** Next commitment-tree index this wallet has not accounted for. */
  readonly commitmentIndex: number
  /** Next ledger-event id to replay from. */
  readonly eventId: number
}

export type DustSyncStep =
  /**
   * Advance a tree across `[start, end]` without its events.
   *
   * Irreversible locally: the witness data for those leaves is gone, and recovering it means
   * re-syncing. Only ever planned for a range below {@link DustSyncTarget.firstRelevant}.
   */
  | {
      readonly kind: 'collapse'
      readonly tree: 'generation' | 'commitment'
      readonly start: number
      readonly end: number
    }
  /** Replay events from `fromId`, at most {@link DUST_EVENT_BATCH} of them. */
  | {readonly kind: 'replay'; readonly fromId: number; readonly limit: number}
  /** Nothing to do: the cursor has reached the tip. */
  | {readonly kind: 'done'}

export type DustSyncTarget = {
  /** Highest generation index the chain has. */
  readonly generationTip: number
  /** Highest commitment index the chain has. */
  readonly commitmentTip: number
  /** Highest ledger-event id the chain has. */
  readonly eventTip: number
  /**
   * The first generation index this wallet has anything at, or `null` when it has nothing.
   *
   * `null` is **not** zero: a wallet with no DUST can collapse the entire history, which is the whole
   * saving. Treating "unknown" as zero would replay 1.2M events to discover nothing.
   */
  readonly firstRelevant: number | null
}

/**
 * The next step of a DUST sync.
 *
 * Collapse before replay, deliberately: collapsing is cheap and bounded while replay is neither, so a
 * plan that replayed first would pay the full cost before discovering it did not have to.
 */
export const nextDustSyncStep = (cursor: DustSyncCursor, target: DustSyncTarget): DustSyncStep => {
  // Everything below the first index we hold anything at can be skipped wholesale. `firstRelevant`
  // null means we hold nothing, so that is the entire tree.
  const relevantFrom = target.firstRelevant ?? target.generationTip + 1
  const collapsibleEnd = Math.min(relevantFrom - 1, target.generationTip)
  if (cursor.generationIndex <= collapsibleEnd) {
    return {kind: 'collapse', tree: 'generation', start: cursor.generationIndex, end: collapsibleEnd}
  }
  if (cursor.commitmentIndex <= target.commitmentTip && target.firstRelevant === null) {
    // Nothing of ours can be in the commitment tree either, so it collapses whole.
    return {kind: 'collapse', tree: 'commitment', start: cursor.commitmentIndex, end: target.commitmentTip}
  }
  if (cursor.eventId <= target.eventTip) {
    return {kind: 'replay', fromId: cursor.eventId, limit: DUST_EVENT_BATCH}
  }
  return {kind: 'done'}
}

/**
 * Whether a reported balance can be trusted as current.
 *
 * A `DustLocalState` answers a balance at any instant whether or not it is synced, so the figure alone
 * cannot say. This is the guard that stops a half-synced state being shown as a spendable amount —
 * "0 DUST" and "we have not looked" are different facts, and only one of them justifies refusing a send.
 */
export const isDustSynced = (cursor: DustSyncCursor, target: DustSyncTarget): boolean =>
  cursor.eventId > target.eventTip && cursor.generationIndex > target.generationTip
