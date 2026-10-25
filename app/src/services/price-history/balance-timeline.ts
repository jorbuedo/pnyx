/**
 * Per-token balance timeline derived from local tx history — the wallet-side
 * half of `value(t) = Σ balance(t) × price(t)`. Pure: consumes the
 * `ReviewedTransaction[]` the app already loads (`useCardanoHistory`) and folds
 * each tx's `ownDelta` (own outputs − own inputs; ADA fee already implicit) into
 * a cumulative, per-asset step function. No indexer, no network.
 *
 * Asset key = the tx-review `assetId` (`"<policyHex>.<assetNameHex>"`); ADA is
 * the empty string `''`. Timestamps are unix **seconds**.
 *
 * @module
 */

import type {ReviewedTransaction} from '@pnyx/tx-review'

/** ADA's asset key in a timeline (tx-review uses an absent assetId for lovelace). */
export const ADA_KEY = ''

/** Balance AFTER the tx at `ts` (base units — lovelace / token minor units). */
export type BalanceStep = {readonly ts: number; readonly balance: bigint}

/** Per-asset cumulative step series, ascending by `ts`. Key `''` = ADA. */
export type BalanceTimeline = ReadonlyMap<string, readonly BalanceStep[]>

const toSec = (iso: string): number | null => {
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null
}

/**
 * Fold confirmed/pending txs into a cumulative per-asset balance timeline.
 * Txs without a timestamp or marked `failed` are skipped (no balance effect).
 * Same-second txs accumulate onto one step (last write wins for that second's
 * running total, which is the correct post-state).
 */
export const buildBalanceTimeline = (txs: readonly ReviewedTransaction[]): BalanceTimeline => {
  const dated = txs
    .filter((t) => t.timestamp !== undefined && t.status !== 'failed')
    .map((t) => ({ts: toSec(t.timestamp as string), tx: t}))
    .filter((x): x is {ts: number; tx: ReviewedTransaction} => x.ts !== null)
    .sort((a, b) => a.ts - b.ts)

  const running = new Map<string, bigint>()
  const series = new Map<string, BalanceStep[]>()

  for (const {ts, tx} of dated) {
    for (const amount of tx.ownDelta) {
      const key = amount.assetId ?? ADA_KEY
      const next = (running.get(key) ?? 0n) + amount.quantity
      running.set(key, next)
      const steps = series.get(key) ?? []
      // Collapse multiple deltas in the same second into a single step.
      const lastStep = steps[steps.length - 1]
      if (lastStep !== undefined && lastStep.ts === ts) {
        steps[steps.length - 1] = {ts, balance: next}
      } else {
        steps.push({ts, balance: next})
      }
      series.set(key, steps)
    }
  }
  return series
}

/**
 * Re-anchor a timeline to the authoritative on-chain balances. The tx-derived
 * cumulative sum only equals reality when history is complete from genesis; a
 * freshly-imported or still-syncing wallet has partial history, so the raw
 * cumulative tip can be wrong (even negative). The current balance is the
 * ground truth, so we shift each asset's series by `current − rawFinal` — the
 * tip then equals the real balance, and earlier points reconstruct history by
 * walking the known deltas backward from the present.
 *
 * `currentBalances` maps asset key → current base-unit balance. An asset held
 * now but absent from the (partial) history gets a synthetic flat step at
 * `floorTsSec` so it still contributes its real value across the window.
 * Assets in the timeline but absent from `currentBalances` are passed through
 * unchanged (their current balance is unknown — better than zeroing them).
 */
export const anchorTimeline = (
  timeline: BalanceTimeline,
  currentBalances: ReadonlyMap<string, bigint>,
  floorTsSec: number,
): BalanceTimeline => {
  const out = new Map<string, readonly BalanceStep[]>()
  for (const [key, steps] of timeline) {
    if (!currentBalances.has(key)) {
      out.set(key, steps)
      continue
    }
    const current = currentBalances.get(key) ?? 0n
    const rawFinal = steps[steps.length - 1]?.balance ?? 0n
    const offset = current - rawFinal
    out.set(key, offset === 0n ? steps : steps.map((s) => ({ts: s.ts, balance: s.balance + offset})))
  }
  // Held-now assets with no history at all → a flat line at their real balance.
  for (const [key, current] of currentBalances) {
    if (!out.has(key) && current !== 0n) out.set(key, [{ts: floorTsSec, balance: current}])
  }
  return out
}

/** Balance of `assetKey` at `tsSec` — the last step at or before it, else 0. */
export const balanceAt = (timeline: BalanceTimeline, assetKey: string, tsSec: number): bigint => {
  const steps = timeline.get(assetKey)
  if (steps === undefined || steps.length === 0 || tsSec < (steps[0]?.ts ?? Number.POSITIVE_INFINITY)) return 0n
  // Binary search: last step with ts <= tsSec.
  let lo = 0
  let hi = steps.length - 1
  let ans = 0n
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const s = steps[mid]
    if (s !== undefined && s.ts <= tsSec) {
      ans = s.balance
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return ans
}

/** Every asset key the wallet has ever touched. */
export const heldAssetKeys = (timeline: BalanceTimeline): readonly string[] => [...timeline.keys()]

/**
 * The span an asset mattered: from its first non-zero balance to its last step.
 * `null` if it was never held with a positive balance. Used to bound how much
 * price history we fetch (only while we held it).
 */
export const heldWindow = (timeline: BalanceTimeline, assetKey: string): {fromSec: number; toSec: number} | null => {
  const steps = timeline.get(assetKey)
  if (steps === undefined || steps.length === 0) return null
  const firstPositive = steps.find((s) => s.balance > 0n)
  const last = steps[steps.length - 1]
  if (firstPositive === undefined || last === undefined) return null
  return {fromSec: firstPositive.ts, toSec: last.ts}
}
