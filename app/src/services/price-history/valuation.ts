/**
 * Valuation — the compose half of `value(t) = Σ balance(t) × price(t)`. Pure.
 * Joins a {@link BalanceTimeline} with a price resolver (USD per whole unit of
 * an asset at a time) to produce a portfolio (or per-token) value series, and
 * attaches a fiat value to a single transaction's `ownDelta` (activity / CSV).
 *
 * The resolver is source-agnostic: Phase 0 backs it with Kraken major-asset
 * series; Phase 2 backs long-tail keys with `tokenAda × adaFiat`. A key the
 * resolver can't price is skipped (never valued at a fabricated 0).
 *
 * @module
 */

import type {ReviewedTransaction} from '@pnyx/tx-review'
import {ADA_KEY, type BalanceTimeline, balanceAt, heldAssetKeys} from './balance-timeline'
import type {PricePoint} from './port'

/** USD (or active-fiat) price per WHOLE unit of `assetKey` at `tsSec`; `null` if unknown. */
export type PriceUsdResolver = (assetKey: string, tsSec: number) => number | null

/** Decimals for an asset key (base units → whole units). ADA = 6. */
export type DecimalsOf = (assetKey: string) => number

/** A point on a value series — `value` in the resolver's fiat. */
export type ValuePoint = {readonly ts: number; readonly value: number}

/** Step-lookup resolver from a close-price series: last point with `ts <= t`. */
export const pointsResolver = (points: readonly PricePoint[]): ((tsSec: number) => number | null) => {
  const sorted = [...points].sort((a, b) => a.ts - b.ts)
  return (tsSec: number) => {
    if (sorted.length === 0 || tsSec < (sorted[0]?.ts ?? Number.POSITIVE_INFINITY)) return null
    let lo = 0
    let hi = sorted.length - 1
    let ans: number | null = null
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const p = sorted[mid]
      if (p !== undefined && p.ts <= tsSec) {
        ans = p.value
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }
    return ans
  }
}

/** `count` evenly-spaced unix-second timestamps across `[fromSec, toSec]` inclusive. */
export const evenTimestamps = (fromSec: number, toSec: number, count: number): number[] => {
  if (count <= 1 || toSec <= fromSec) return [toSec]
  const step = (toSec - fromSec) / (count - 1)
  return Array.from({length: count}, (_, i) => Math.round(fromSec + step * i))
}

const wholeUnits = (balance: bigint, decimals: number): number => Number(balance) / 10 ** decimals

/**
 * Aggregate portfolio value at each sample timestamp: sum over every held asset
 * of `balance(asset,t) × price(asset,t)`. Unpriced assets contribute nothing.
 * Restrict the summed assets with `assetKeys` (e.g. a single token, or majors).
 */
export const buildValueSeries = (
  timeline: BalanceTimeline,
  sampleTsSec: readonly number[],
  resolver: PriceUsdResolver,
  decimalsOf: DecimalsOf,
  assetKeys: readonly string[] = heldAssetKeys(timeline),
): ValuePoint[] =>
  sampleTsSec.map((ts) => {
    let value = 0
    for (const key of assetKeys) {
      const bal = balanceAt(timeline, key, ts)
      if (bal === 0n) continue
      const price = resolver(key, ts)
      if (price === null) continue
      value += wholeUnits(bal, decimalsOf(key)) * price
    }
    return {ts, value}
  })

/**
 * Fiat value of a single tx's net effect: sum over its `ownDelta` of
 * `(qty / 10^decimals) × price(assetKey, txTime)`. Positive = net received.
 * `null` when the tx has no timestamp or no leg could be priced.
 */
export const txFiatDelta = (
  tx: ReviewedTransaction,
  resolver: PriceUsdResolver,
  decimalsOf: DecimalsOf,
): number | null => {
  if (tx.timestamp === undefined) return null
  const ms = Date.parse(tx.timestamp)
  if (!Number.isFinite(ms)) return null
  const ts = Math.floor(ms / 1000)
  let total = 0
  let priced = false
  for (const amount of tx.ownDelta) {
    const key = amount.assetId ?? ADA_KEY
    const price = resolver(key, ts)
    if (price === null) continue
    priced = true
    total += wholeUnits(amount.quantity, decimalsOf(key)) * price
  }
  return priced ? total : null
}
