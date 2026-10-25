/**
 * Normalized swap types shared by the SteelSwap adapters and every consumer
 * (hooks, screens). Units are swap-engine units (ADA = `"lovelace"`; see
 * `swap-asset.ts`); amounts are base-unit integer strings.
 *
 * ⚠️ Two amount conventions exist in this API and they are NOT interchangeable:
 * the V2 swap family lets the JSON *type* carry the scale (an integer or decimal
 * string is base units, a JSON float is a decimal-adjusted display amount),
 * while the ATC limit-order family takes integer base units only. Everything
 * here is base units as a string, and each adapter converts at its own edge.
 *
 * @module
 */

import type {Effect} from 'effect'
import type {SteelswapError} from '../cardano-assets/steelswap'
import type {FetchLike} from '../cardano-assets/token-metadata'

export type SwapAmount = {readonly unit: string; readonly amount: string}

/** One routed hop. `kind` ∈ ammSwap | orderbookFill | mintBurn — the settlement classifier. */
export type SwapLeg = {
  readonly kind: string
  readonly dex: string
  readonly poolId: string | null
  readonly input: SwapAmount | null
  readonly output: SwapAmount | null
  readonly batcherFee: SwapAmount | null
}

/**
 * How the combined SteelSwap fee ended up being paid.
 *
 * `babel` means it came out of the INPUT token rather than ADA, which is what
 * lets a token-rich / ADA-poor wallet swap at all. A user paying in SNEK instead
 * of ADA has to be told, so this is surfaced in review rather than swallowed.
 */
export type BabelInfo = {
  readonly available: boolean | null
  readonly applied: boolean | null
  readonly resolvedPath: 'ada' | 'babel' | 'allInclusive' | null
  readonly feeUnit: string | null
  readonly feeAmount: string | null
}

export type SwapEstimate = {
  readonly input: SwapAmount
  readonly output: SwapAmount
  /** INPUT per one unit of OUTPUT, batcher fee included. */
  readonly effectivePrice: number
  /**
   * How much splitting across venues beat the single best venue by. `null` when
   * the split did not help or only one venue could serve the trade.
   *
   * (There is deliberately no `priceImpact`: the API documents it as always
   * omitted, because one figure has no clean meaning across a split route.)
   */
  readonly bonusOutput: string | null
  readonly fees: {readonly batcher: SwapAmount; readonly deposit: SwapAmount; readonly service: SwapAmount}
  readonly split: readonly SwapLeg[]
  readonly babel: BabelInfo | null
}

/** How the SteelSwap fee is paid (babel-fee). Default `ifNeeded`. */
export type BabelMode = 'none' | 'ifNeeded' | 'force'

/**
 * Which side of the pair the user fixed. Exactly one side may be complete —
 * a body carrying both, or neither, is rejected with 422.
 */
export type SwapSide =
  /** "I offer exactly this much" — predicts the output. */
  | {readonly kind: 'exactIn'; readonly inputUnit: string; readonly amount: string; readonly outputUnit: string}
  /** "I want exactly this much back" — predicts the input. */
  | {readonly kind: 'exactOut'; readonly inputUnit: string; readonly outputUnit: string; readonly amount: string}

export type EstimateOptions = {
  /** DEX brands to exclude, matched against `GET /dexes` ids. */
  readonly ignore?: readonly string[]
  readonly babelFee?: BabelMode
  /**
   * Treat an ADA input as the TOTAL leaving the wallet: batcher fee, deposits,
   * the service fee and a 1 ADA buffer are netted out of it. ADA input only.
   */
  readonly allInclusive?: boolean
  /** Makes the babel block wallet-aware instead of a wallet-blind preview. */
  readonly addressSource?: string
  readonly utxos?: readonly string[]
}

export type BuildSwapParams = {
  readonly side: SwapSide
  /** From the estimate — the floor the rebuilt output must clear. */
  readonly expectedOutput: SwapAmount
  /** REQUIRED on an exactOut build: the ceiling the rebuilt input must stay under. */
  readonly expectedInput?: SwapAmount
  /** Max slippage in basis points (0–5000). */
  readonly slippageBps: number
  readonly ttlSeconds?: number
  /** Wallet address that sources funds (bech32). */
  readonly addressSource: string
  readonly changeAddress?: string
  /** Wallet UTxOs as CIP-30 TransactionUnspentOutput hexes. */
  readonly utxos?: readonly string[]
  /** Pure-ADA UTxO hexes for collateral (Plutus routes). */
  readonly collateral?: readonly string[]
  readonly babelFee?: BabelMode
  readonly allInclusive?: boolean
  readonly ignore?: readonly string[]
  /** Resting orders to cancel in the SAME transaction, funding the swap. */
  readonly cancelUtxos?: readonly OrderRef[]
}

export type BuiltSwap = {
  /** Unsigned transaction CBOR (hex) — sign + submit via the wallet. */
  readonly txCbor: string
  /** The transaction id, fixed at build time and unchanged by our signature. */
  readonly txHash: string | null
  /**
   * True when the transaction ALREADY carries a SteelSwap witness, so ours must
   * be ADDED to the witness set rather than replacing it.
   */
  readonly partialSign: boolean
  readonly babel: BabelInfo | null
}

export type BatcherProtocol = {
  readonly protocol: string
  /** `QUIET | HEALTHY | WARN | DOWN`, or `null` when never snapshotted (missing data, not an error). */
  readonly status: string | null
  readonly lastClearedSlot: number | null
  readonly demandCount: number | null
  readonly oldestDemandAgeBlocks: number | null
  readonly warnThresholdBlocks: number | null
  readonly downThresholdBlocks: number | null
}

export type OrderRef = {readonly txHash: string; readonly txIndex: number}

/** Why a requested cancel produced no transaction. */
export type SkippedOrder = {
  readonly txHash: string
  readonly txIndex: number
  /** `not_found | already_executed | not_cancellable | unknown_dex | axo` */
  readonly reason: string
}

/** An order that WAS cancelled but whose original fee could not be refunded. */
export type RefundSkipped = {
  readonly txHash: string
  readonly txIndex: number
  /** `dex_excluded | no_signing_key | fee_utxo_unavailable` */
  readonly reason: string
}

export type CancelTransaction = BuiltSwap & {
  /** `v1` (hash-datum) or `v2v3` (inline-datum) — one tx cannot mix the two. */
  readonly plutusVersion: string
  readonly cancelledRefs: readonly OrderRef[]
}

/**
 * ⚠️ An all-skipped batch is a `200` with `transactions: []`, not an error — a
 * caller that only handles the failure path renders nothing at all.
 */
export type CancelResult = {
  readonly transactions: readonly CancelTransaction[]
  readonly skipped: readonly SkippedOrder[]
  readonly refundSkipped: readonly RefundSkipped[]
}

export type SwapOrder = {
  readonly txHash: string
  readonly status: string
  readonly orderType: string
  readonly timeSec: number | null
  readonly pair: readonly string[] | null
  readonly offer: readonly SwapAmount[]
  readonly minReceive: readonly SwapAmount[]
  readonly received: readonly SwapAmount[]
  readonly remaining: readonly SwapAmount[]
  readonly fillReason: string | null
  readonly legCount: number
  readonly legs: readonly SwapLeg[]
  /** The app brand that built the tx, read from its on-chain message. */
  readonly source: string | null
}

export type OrdersPage = {
  readonly items: readonly SwapOrder[]
  readonly cursor: string | null
}

export type OrdersQuery = {
  /** Bech32 base, enterprise or stake addresses — matched on payment AND stake credential. */
  readonly addresses: readonly string[]
  readonly status?: readonly string[]
  readonly cursor?: string | null
  readonly limit?: number
  /** Inline the heavy fields. Omitted by default to keep the list small. */
  readonly expand?: readonly ('legs' | 'route')[]
}

// ── shared parse helpers ──

/**
 * A base-unit amount as a string.
 *
 * ⚠️ A JSON **number** here means SteelSwap already decimal-adjusted it (it does
 * that when the request used decimal amounts). We always send base units, so a
 * number should not appear; truncating is the safe read if one ever does.
 */
export const amountStr = (v: unknown): string =>
  typeof v === 'number' ? Math.trunc(v).toString() : typeof v === 'string' ? v : '0'

export const asAmount = (v: unknown): SwapAmount => {
  const o = (v ?? {}) as {unit?: unknown; amount?: unknown}
  return {unit: typeof o.unit === 'string' ? o.unit : '', amount: amountStr(o.amount)}
}

export const asAmounts = (v: unknown): readonly SwapAmount[] => (Array.isArray(v) ? v.map(asAmount) : [])

/** One SteelSwap API version adapter. All methods normalize to the types above. */
export type SwapProvider = {
  readonly fetchEstimate: (
    side: SwapSide,
    nowMs: number,
    options?: EstimateOptions,
    fetchImpl?: FetchLike,
  ) => Effect.Effect<SwapEstimate, SteelswapError>
  readonly buildSwap: (
    params: BuildSwapParams,
    nowMs: number,
    fetchImpl?: FetchLike,
  ) => Effect.Effect<BuiltSwap, SteelswapError>
  readonly notifySwap: (
    txHash: string,
    txCbor: string,
    nowMs: number,
    fetchImpl?: FetchLike,
  ) => Effect.Effect<void, SteelswapError>
  readonly fetchOrder: (
    txHash: string,
    nowMs: number,
    fetchImpl?: FetchLike,
  ) => Effect.Effect<SwapOrder, SteelswapError>
  readonly fetchOrders: (
    query: OrdersQuery,
    nowMs: number,
    fetchImpl?: FetchLike,
  ) => Effect.Effect<OrdersPage, SteelswapError>
  readonly cancelSwap: (
    orders: readonly OrderRef[],
    changeAddress: string,
    collateral: readonly string[] | undefined,
    nowMs: number,
    fetchImpl?: FetchLike,
  ) => Effect.Effect<CancelResult, SteelswapError>
  readonly fetchBatcherStatus: (
    nowMs: number,
    fetchImpl?: FetchLike,
  ) => Effect.Effect<readonly BatcherProtocol[], SteelswapError>
}
