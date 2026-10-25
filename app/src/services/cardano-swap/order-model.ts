/**
 * One order model over SteelSwap's TWO order books.
 *
 * The AMM aggregator (`/api/v2/orders`) and the ATC limit book
 * (`/api/v2/atc/orders`) are separate stores that disagree about almost
 * everything structural, and an order from one never appears in the other. The
 * Orders screen shows a single merged list, so the reconciliation happens here —
 * deliberately, in one pure module, rather than by defaulting inside a row
 * component:
 *
 * | | AMM | ATC (limit) |
 * |---|---|---|
 * | id | `txHash` of the opening tx | `txHash#index` |
 * | owner keyed on | payment AND stake credential | **staking credential only** |
 * | statuses | OPEN LIMIT PARTIALLY_FILLED PARTIALLY_CANCELLED FILLED CANCELLED ERROR MIXED MEMPOOL ROLLED_BACK | OPEN LIMIT FILLED CANCELLED |
 * | time | `timeSec` (unix) | `ageSlots` only — no timestamp |
 * | credential | required | none |
 *
 * ⚠️ `ROLLED_BACK` exists as an aggregate status but **cannot be used as a list
 * filter** — the API rejects it — so it is not offered as a chip.
 *
 * ⚠️ An ATC order carries no timestamp at all. `ageSlots` is converted to an
 * approximate placed-at only when a chain tip is supplied; without one the time
 * stays `null` rather than becoming a plausible-looking lie.
 *
 * @module
 */

import type {AtcOrder} from './atc-client'
import type {SwapAmount, SwapOrder} from './types'

export type OrderRail = 'amm' | 'limit'

/** The one status vocabulary the UI renders, folded from both rails. */
export type OrderStatus =
  | 'mempool'
  | 'open'
  | 'partiallyFilled'
  | 'filled'
  | 'cancelled'
  | 'partiallyCancelled'
  | 'error'
  | 'mixed'
  | 'rolledBack'
  | 'unknown'

export type NormalizedOrder = {
  readonly rail: OrderRail
  /** AMM: the opening `txHash`. Limit: `txHash#index`. Unique across both. */
  readonly id: string
  /** The tx that opened the order — the same value for both rails. */
  readonly txHash: string
  readonly status: OrderStatus
  /** Unix seconds, or `null` when the rail does not report one. */
  readonly timeSec: number | null
  readonly offer: readonly SwapAmount[]
  readonly received: readonly SwapAmount[]
  /** The least the order will accept — what to show while nothing has filled. */
  readonly minReceive: readonly SwapAmount[]
  readonly remaining: readonly SwapAmount[]
  /** The venue serving the order. `null` for a limit order — ATC is its own book. */
  readonly venue: string | null
  /** The on-chain limit as a reduced rational, limit orders only. */
  readonly limitPrice: {readonly numerator: string; readonly denominator: string} | null
  readonly pair: readonly string[] | null
  /** Whether a cancel can be attempted. A terminal order cannot. */
  readonly cancellable: boolean
}

/**
 * Statuses in which an order still has work OUTSTANDING — the ones a cancel can
 * act on.
 *
 * ⚠️ `mixed` is NOT one of them, however much it looks like a middle state. The
 * API defines the vocabulary as: `OPEN`/`LIMIT` while work is outstanding;
 * `PARTIALLY_FILLED`/`PARTIALLY_CANCELLED` when part completed and part is still
 * open; `FILLED`/`CANCELLED`/`ERROR` when everything reached that *same* end
 * state; and `MIXED` when the executions **ended** in different states. "Ended"
 * makes `MIXED` terminal.
 *
 * Reading it as resting put seven settled orders under Open with a Cancel
 * button, and every one of them came back `already_executed` — a button that
 * could only ever fail.
 */
const RESTING: ReadonlySet<OrderStatus> = new Set<OrderStatus>(['open', 'partiallyFilled', 'partiallyCancelled'])

/**
 * The AMM rail's status vocabulary. `LIMIT` there means "resting order on a
 * venue that has one" — it is NOT the ATC limit book, and it folds to `open`.
 */
export const ammStatus = (raw: string): OrderStatus => {
  switch (raw.toUpperCase()) {
    case 'MEMPOOL':
      return 'mempool'
    case 'OPEN':
    case 'LIMIT':
      return 'open'
    case 'PARTIALLY_FILLED':
      return 'partiallyFilled'
    case 'PARTIALLY_CANCELLED':
      return 'partiallyCancelled'
    case 'FILLED':
      return 'filled'
    case 'CANCELLED':
      return 'cancelled'
    case 'ERROR':
      return 'error'
    case 'MIXED':
      return 'mixed'
    case 'ROLLED_BACK':
      return 'rolledBack'
    default:
      return 'unknown'
  }
}

export const atcStatus = (raw: string): OrderStatus => {
  switch (raw.toUpperCase()) {
    case 'OPEN':
    case 'LIMIT':
      return 'open'
    case 'FILLED':
      return 'filled'
    case 'CANCELLED':
      return 'cancelled'
    default:
      return 'unknown'
  }
}

/** Sum amounts per unit, preserving order of first appearance. */
const sumByUnit = (amounts: readonly (SwapAmount | null)[]): readonly SwapAmount[] => {
  const totals = new Map<string, bigint>()
  for (const a of amounts) {
    if (a === null || a.unit === '') continue
    totals.set(a.unit, (totals.get(a.unit) ?? 0n) + BigInt(a.amount))
  }
  return [...totals].map(([unit, amount]) => ({unit, amount: amount.toString()}))
}

export const normalizeAmmOrder = (o: SwapOrder): NormalizedOrder => {
  const status = ammStatus(o.status)
  // ⚠️ The top-level aggregates are NOT always populated: a live FILLED
  // `ADVANCED_ORDER_TYPE` order comes back with `offer: []`, `received: []` and
  // two legs carrying the real amounts. Falling back to the legs is what makes
  // such an order show a number instead of a blank row.
  const offer = o.offer.length > 0 ? o.offer : sumByUnit(o.legs.map((l) => l.input))
  const received = o.received.length > 0 ? o.received : sumByUnit(o.legs.map((l) => l.output))
  return {
    rail: 'amm',
    id: o.txHash,
    txHash: o.txHash,
    status,
    timeSec: o.timeSec,
    offer,
    received,
    minReceive: o.minReceive,
    remaining: o.remaining,
    // A mempool order has no execution yet, so it has no venue to name.
    venue: o.legs[0]?.dex ?? null,
    limitPrice: null,
    pair: o.pair,
    // A mempool order is not indexed yet, so a cancel would answer `not_found`.
    cancellable: RESTING.has(status),
  }
}

/** Cardano's protocol parameter: one slot is one second. */
const SLOT_SECONDS = 1

/**
 * @param tipSlot the chain tip's slot and its wall-clock second, when known.
 *   Without it an ATC order's `timeSec` stays `null` — `ageSlots` alone cannot
 *   be turned into a timestamp, and inventing one would misorder the merged list.
 */
export const normalizeAtcOrder = (
  o: AtcOrder,
  tip?: {readonly slot: number; readonly atSec: number},
): NormalizedOrder => {
  const status = atcStatus(o.status)
  const [txHash] = o.orderId.split('#')
  const offered = BigInt(o.offer.amount)
  const available = BigInt(o.available)
  const filled = offered > available ? offered - available : 0n
  return {
    rail: 'limit',
    id: o.orderId,
    txHash: txHash ?? o.orderId,
    status,
    timeSec: tip === undefined || o.ageSlots === null ? null : tip.atSec - o.ageSlots * SLOT_SECONDS,
    offer: [{unit: o.offer.unit, amount: o.offer.amount}],
    // ATC reports what is LEFT, not what came back; the filled part is the
    // difference, and it is denominated in the offered token, not the ask.
    received: filled > 0n ? [{unit: o.offer.unit, amount: filled.toString()}] : [],
    // A limit order states exactly what it asks for, so that IS the min receive.
    minReceive: [{unit: o.ask.unit, amount: o.ask.amount}],
    remaining: available > 0n ? [{unit: o.offer.unit, amount: o.available}] : [],
    venue: null,
    limitPrice: o.swapPrice,
    pair: o.pair.length > 0 ? o.pair : null,
    cancellable: RESTING.has(status),
  }
}

/**
 * Merge both rails into one list, newest first.
 *
 * Orders with no timestamp (an ATC order read without a chain tip) sort after
 * every dated one rather than being dropped or dated arbitrarily — they are
 * still real orders the user has to be able to act on.
 */
export const mergeOrders = (
  amm: readonly NormalizedOrder[],
  limit: readonly NormalizedOrder[],
): readonly NormalizedOrder[] =>
  // ⚠️ Deduped by rail+id before sorting. A logical order is keyed on its
  // opening tx hash, and the live list DOES repeat one — an advanced order that
  // produced several executions, and a MEMPOOL item that the indexed order then
  // joins on the same first page. Two rows with one id is a React duplicate-key
  // warning and a cancel that acts on an ambiguous target.
  dedupeById([...amm, ...limit]).sort((a, b) => {
    if (a.timeSec === b.timeSec) return a.id < b.id ? 1 : -1
    if (a.timeSec === null) return 1
    if (b.timeSec === null) return -1
    return b.timeSec - a.timeSec
  })

/** First occurrence wins — the list is already newest-first per rail. */
const dedupeById = (orders: readonly NormalizedOrder[]): NormalizedOrder[] => {
  const seen = new Set<string>()
  const out: NormalizedOrder[] = []
  for (const o of orders) {
    const key = `${o.rail}:${o.id}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(o)
  }
  return out
}

/** The filter chips the Orders screen offers. */
export type OrderFilter = 'all' | 'open' | 'filled' | 'cancelled'

/**
 * ⚠️ `open` is exactly {@link RESTING} plus `mempool`, and that is a rule, not a
 * coincidence: an order the list offers to CANCEL must be findable under Open.
 * They were two hand-written lists once, and `MIXED` — cancellable, but missing
 * from `open` — made the filter come back empty while the rows beneath it still
 * showed a Cancel button. `filterOrdersMatchCancellable` locks it.
 */
const FILTERS: Record<OrderFilter, ReadonlySet<OrderStatus>> = {
  all: new Set(),
  open: new Set<OrderStatus>(['mempool', ...RESTING]),
  filled: new Set<OrderStatus>(['filled']),
  cancelled: new Set<OrderStatus>(['cancelled', 'error', 'rolledBack']),
}

export const filterOrders = (
  orders: readonly NormalizedOrder[],
  filter: OrderFilter,
  rail: OrderRail | 'both',
): readonly NormalizedOrder[] =>
  orders.filter((o) => (rail === 'both' || o.rail === rail) && (filter === 'all' || FILTERS[filter].has(o.status)))
