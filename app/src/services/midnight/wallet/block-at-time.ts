/**
 * Which block a moment in time falls in — how a wallet that predates plan item 61(a) gets a birthday.
 *
 * A wallet created before birthdays were recorded has none, and its creation height cannot be
 * recovered from the chain. What the app *does* hold is `WalletGroup.createdAt`, and the indexer
 * serves `Block.timestamp`, so a binary search turns one into the other in about twenty requests on a
 * chain of millions.
 *
 * ⚠️ **It rounds DOWN, always** — the highest block at or before the target. A birthday later than the
 * truth skips the blocks between, silently and permanently, since nothing rescans a range the cursor
 * has passed. Scanning a few blocks too many costs seconds; scanning too few costs coins.
 *
 * ⚠️ **A gap stops the search rather than being guessed past.** If the indexer cannot answer for a
 * height in the middle of the range, narrowing on either side would be picking a bound on no evidence,
 * and the result would be a birthday nobody could tell was wrong.
 *
 * The search is pure over an injected reader so it can be tested against a fabricated chain: the rule
 * is arithmetic, and the only thing a real indexer adds to it is latency.
 *
 * @module
 */

export type BlockAtTimeResult =
  | {readonly kind: 'found'; readonly height: number; readonly timestampMs: number; readonly reads: number}
  /** Every block in the chain is newer than the target — the chain itself started after it. */
  | {readonly kind: 'before-genesis'; readonly reads: number}
  | {readonly kind: 'unreadable'; readonly atHeight: number; readonly reads: number}

/**
 * The highest block whose timestamp is at or before `targetMs`.
 *
 * `readTimestamp` answers epoch **milliseconds**, which is what the indexer's `Block.timestamp` is, or
 * `null` for a height it cannot answer for.
 */
export const blockAtOrBefore = async (params: {
  readonly targetMs: number
  readonly tipHeight: number
  readonly readTimestamp: (height: number) => Promise<number | null>
}): Promise<BlockAtTimeResult> => {
  const {targetMs, tipHeight, readTimestamp} = params
  let reads = 0
  const read = async (height: number): Promise<number | null> => {
    reads += 1
    return readTimestamp(height)
  }

  if (tipHeight < 1) return {kind: 'before-genesis', reads}

  // The cheap answer first: a target at or after the tip is the tip, and a wallet created today is the
  // overwhelmingly common case for a backfill.
  const atTip = await read(tipHeight)
  if (atTip === null) return {kind: 'unreadable', atHeight: tipHeight, reads}
  if (atTip <= targetMs) return {kind: 'found', height: tipHeight, timestampMs: atTip, reads}

  const first = await read(1)
  if (first === null) return {kind: 'unreadable', atHeight: 1, reads}
  if (first > targetMs) return {kind: 'before-genesis', reads}

  // Invariant: `low` is at or before the target, `high` is after it. Both are known, never assumed.
  let low = 1
  let lowTime = first
  let high = tipHeight
  while (high - low > 1) {
    const mid = low + Math.floor((high - low) / 2)
    const at = await read(mid)
    if (at === null) return {kind: 'unreadable', atHeight: mid, reads}
    if (at <= targetMs) {
      low = mid
      lowTime = at
    } else {
      high = mid
    }
  }
  return {kind: 'found', height: low, timestampMs: lowTime, reads}
}
