/**
 * SteelSwap v2 swap adapter — the keyed `cicdapi/api/v2/*` surface, shared with
 * the token-data client (`steelswapAuthedJson`, Bearer + 401 re-mint + 429
 * backoff). Estimate / build / notify / orders / cancel / batcher, normalized to
 * the `types.ts` shapes.
 *
 * Two things this adapter is careful about:
 *
 * - **The quote and the build must agree on the fee.** `fees.service` is
 *   resolved from the authenticated caller, so both calls have to be made with
 *   the same credential — which they are, since both go through the shared key.
 * - **`quote_changed` is a `409` carrying the FRESH quote.** It is not a
 *   generic failure: the caller re-confirms at the new price rather than
 *   silently rebuilding, so the fresh estimate is parsed back out of the error
 *   body (see {@link quoteChangedEstimate}).
 *
 * @module
 */

import {Effect} from 'effect'
import {getCardanoAssetsConfig} from '../cardano-assets/config'
import {steelswapPublicJson as publicJson, type SteelswapError, steelswapAuthedJson} from '../cardano-assets/steelswap'
import type {FetchLike} from '../cardano-assets/token-metadata'
import {
  asAmount,
  asAmounts,
  type BabelInfo,
  type BatcherProtocol,
  type BuildSwapParams,
  type BuiltSwap,
  type CancelResult,
  type CancelTransaction,
  type EstimateOptions,
  type OrderRef,
  type OrdersPage,
  type OrdersQuery,
  type RefundSkipped,
  type SkippedOrder,
  type SwapEstimate,
  type SwapLeg,
  type SwapOrder,
  type SwapProvider,
  type SwapSide,
} from './types'

const defaultFetch: FetchLike = (url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<FetchLike>
const config = () => getCardanoAssetsConfig('mainnet')

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

const parseBabel = (v: unknown): BabelInfo | null => {
  if (v === null || typeof v !== 'object') return null
  const b = v as Record<string, unknown>
  const path = b.resolvedPath
  return {
    available: typeof b.available === 'boolean' ? b.available : null,
    applied: typeof b.applied === 'boolean' ? b.applied : null,
    resolvedPath: path === 'ada' || path === 'babel' || path === 'allInclusive' ? path : null,
    feeUnit: str(b.feeUnit),
    feeAmount:
      typeof b.feeAmount === 'string' ? b.feeAmount : typeof b.feeAmount === 'number' ? String(b.feeAmount) : null,
  }
}

/**
 * One execution.
 *
 * ⚠️ An `ammSwapLeg` names its amounts `offer` / `received` — verified against
 * the live response. `input` / `output` is the *estimate* leg's naming, and
 * reading only those left every order's amounts null.
 */
const parseLeg = (v: unknown): SwapLeg => {
  const leg = (v ?? {}) as Record<string, unknown>
  const input = leg.input ?? leg.offer
  const output = leg.output ?? leg.received
  return {
    kind: typeof leg.kind === 'string' ? leg.kind : 'unknown',
    dex: typeof leg.dex === 'string' ? leg.dex : '',
    poolId: str(leg.poolId),
    input: input !== undefined && input !== null ? asAmount(input) : null,
    output: output !== undefined && output !== null ? asAmount(output) : null,
    batcherFee: leg.batcherFee !== undefined && leg.batcherFee !== null ? asAmount(leg.batcherFee) : null,
  }
}

export const parseEstimate = (body: unknown): SwapEstimate => {
  const b = (body ?? {}) as Record<string, unknown>
  const fees = (b.fees ?? {}) as Record<string, unknown>
  const split = Array.isArray(b.split) ? b.split : []
  const bonus = b.bonusOutput
  return {
    input: asAmount(b.input),
    output: asAmount(b.output),
    effectivePrice: typeof b.effectivePrice === 'number' ? b.effectivePrice : 0,
    bonusOutput: typeof bonus === 'string' ? bonus : typeof bonus === 'number' ? String(bonus) : null,
    fees: {batcher: asAmount(fees.batcher), deposit: asAmount(fees.deposit), service: asAmount(fees.service)},
    split: split.map(parseLeg),
    babel: parseBabel(b.babel),
  }
}

const parseBuilt = (body: unknown): BuiltSwap => {
  const b = (body ?? {}) as Record<string, unknown>
  return {
    txCbor: typeof b.txCbor === 'string' ? b.txCbor : '',
    txHash: str(b.txHash),
    partialSign: b.partialSign === true,
    babel: parseBabel(b.babel),
  }
}

/**
 * The fresh quote a `409 quote_changed` carries, or `null` when the error is
 * something else. The caller shows the delta and asks again — it must never
 * rebuild silently at the new price.
 */
export const quoteChangedEstimate = (e: SteelswapError): SwapEstimate | null => {
  if (e.code !== 'quote_changed' || e.body === null || e.body === undefined) return null
  const quote = e.body.quote ?? e.body.estimate ?? e.body
  return parseEstimate(quote)
}

/** The request body shared by estimate / build / assemble. */
const sideBody = (side: SwapSide): Record<string, unknown> =>
  side.kind === 'exactIn'
    ? {input: {unit: side.inputUnit, amount: side.amount}, outputUnit: side.outputUnit}
    : {inputUnit: side.inputUnit, output: {unit: side.outputUnit, amount: side.amount}}

const fetchEstimate = (
  side: SwapSide,
  nowMs: number,
  options: EstimateOptions = {},
  fetchImpl: FetchLike = defaultFetch,
): Effect.Effect<SwapEstimate, SteelswapError> =>
  steelswapAuthedJson(
    config(),
    '/api/v2/swap/estimate',
    {
      method: 'post',
      body: JSON.stringify({
        ...sideBody(side),
        ignore: options.ignore ?? [],
        babelFee: options.babelFee ?? 'ifNeeded',
        ...(options.allInclusive === true ? {allInclusive: true} : {}),
        ...(options.addressSource !== undefined ? {addressSource: options.addressSource} : {}),
        ...(options.utxos !== undefined ? {utxos: options.utxos} : {}),
      }),
    },
    nowMs,
    fetchImpl,
  ).pipe(Effect.map(parseEstimate))

const buildSwap = (
  params: BuildSwapParams,
  nowMs: number,
  fetchImpl: FetchLike = defaultFetch,
): Effect.Effect<BuiltSwap, SteelswapError> =>
  steelswapAuthedJson(
    config(),
    '/api/v2/swap/build',
    {
      method: 'post',
      body: JSON.stringify({
        ...sideBody(params.side),
        expectedOutput: params.expectedOutput,
        // Required on an exactOut build, ignored on exactIn — so it is sent only
        // where it means something.
        ...(params.side.kind === 'exactOut' && params.expectedInput !== undefined
          ? {expectedInput: params.expectedInput}
          : {}),
        slippageBps: params.slippageBps,
        ttlSeconds: params.ttlSeconds ?? 600,
        addressSource: params.addressSource,
        ignore: params.ignore ?? [],
        babelFee: params.babelFee ?? 'ifNeeded',
        ...(params.allInclusive === true ? {allInclusive: true} : {}),
        ...(params.changeAddress !== undefined ? {changeAddress: params.changeAddress} : {}),
        ...(params.utxos !== undefined ? {utxos: params.utxos} : {}),
        ...(params.collateral !== undefined ? {collateral: params.collateral} : {}),
        ...(params.cancelUtxos !== undefined && params.cancelUtxos.length > 0 ? {cancelUtxos: params.cancelUtxos} : {}),
      }),
    },
    nowMs,
    fetchImpl,
  ).pipe(Effect.map(parseBuilt))

/**
 * Register a just-broadcast swap so it shows as a `MEMPOOL` order during the
 * window before the chain listener indexes it. Idempotent server-side, and a
 * `204` on success.
 */
const notifySwap = (
  txHash: string,
  txCbor: string,
  nowMs: number,
  fetchImpl: FetchLike = defaultFetch,
): Effect.Effect<void, SteelswapError> =>
  steelswapAuthedJson(
    config(),
    '/api/v2/swap/notify',
    {method: 'post', body: JSON.stringify({txHash, txCbor})},
    nowMs,
    fetchImpl,
  ).pipe(Effect.asVoid)

const parseOrder = (body: unknown, fallbackHash: string): SwapOrder => {
  const b = (body ?? {}) as Record<string, unknown>
  const source = (b.source ?? null) as {brand?: unknown} | null
  return {
    txHash: typeof b.txHash === 'string' ? b.txHash : fallbackHash,
    status: typeof b.status === 'string' ? b.status : 'unknown',
    orderType: typeof b.orderType === 'string' ? b.orderType : '',
    timeSec: num(b.timeSec),
    pair: Array.isArray(b.pair) ? b.pair.filter((p): p is string => typeof p === 'string') : null,
    offer: asAmounts(b.offer),
    minReceive: asAmounts(b.minReceive),
    received: asAmounts(b.received),
    remaining: asAmounts(b.remaining),
    fillReason: str(b.fillReason),
    legCount: num(b.legCount) ?? 0,
    legs: Array.isArray(b.legs) ? b.legs.map(parseLeg) : [],
    source: source !== null && typeof source.brand === 'string' ? source.brand : null,
  }
}

const fetchOrder = (
  txHash: string,
  nowMs: number,
  fetchImpl: FetchLike = defaultFetch,
): Effect.Effect<SwapOrder, SteelswapError> =>
  steelswapAuthedJson(config(), `/api/v2/orders/${txHash}`, {}, nowMs, fetchImpl).pipe(
    Effect.map((b) => parseOrder(b, txHash)),
  )

/**
 * A page of the wallet's logical orders, newest first.
 *
 * ⚠️ `MEMPOOL` items are added ON TOP of the first page, so a first page can
 * hold more than `limit` entries, and they never appear on later pages.
 */
const fetchOrders = (
  query: OrdersQuery,
  nowMs: number,
  fetchImpl: FetchLike = defaultFetch,
): Effect.Effect<OrdersPage, SteelswapError> => {
  const p: string[] = []
  for (const a of query.addresses) p.push(`addresses=${encodeURIComponent(a)}`)
  for (const s of query.status ?? []) p.push(`status=${encodeURIComponent(s)}`)
  if (query.cursor != null && query.cursor.length > 0) p.push(`cursor=${encodeURIComponent(query.cursor)}`)
  if (query.limit !== undefined) p.push(`limit=${query.limit}`)
  if (query.expand !== undefined && query.expand.length > 0) p.push(`expand=${query.expand.join(',')}`)
  return steelswapAuthedJson(config(), `/api/v2/orders?${p.join('&')}`, {}, nowMs, fetchImpl).pipe(
    Effect.map((body) => {
      const b = (body ?? {}) as {items?: unknown; cursor?: unknown}
      const rows = Array.isArray(b.items) ? b.items : []
      return {items: rows.map((r) => parseOrder(r, '')), cursor: str(b.cursor)}
    }),
  )
}

const parseRef = (v: unknown): OrderRef | null => {
  const o = (v ?? {}) as {txHash?: unknown; txIndex?: unknown}
  if (typeof o.txHash !== 'string' || typeof o.txIndex !== 'number') return null
  return {txHash: o.txHash, txIndex: o.txIndex}
}

const parseSkipped = (v: unknown): SkippedOrder | RefundSkipped | null => {
  const o = (v ?? {}) as {txHash?: unknown; txIndex?: unknown; reason?: unknown}
  if (typeof o.txHash !== 'string' || typeof o.txIndex !== 'number') return null
  return {txHash: o.txHash, txIndex: o.txIndex, reason: typeof o.reason === 'string' ? o.reason : 'unknown'}
}

/**
 * Build the unsigned cancels for a batch of resting orders.
 *
 * Returns ONE transaction per Plutus-version bucket — zero, one or two, because
 * a single tx cannot mix V1 hash-datum and V2/V3 inline-datum witness styles.
 * Anything not cancellable rides back in `skipped` rather than failing the
 * request, so an all-skipped batch is a 200 with no transactions.
 */
const cancelSwap = (
  orders: readonly OrderRef[],
  changeAddress: string,
  collateral: readonly string[] | undefined,
  nowMs: number,
  fetchImpl: FetchLike = defaultFetch,
): Effect.Effect<CancelResult, SteelswapError> =>
  steelswapAuthedJson(
    config(),
    '/api/v2/swap/cancel',
    {
      method: 'post',
      body: JSON.stringify({orders, changeAddress, ...(collateral !== undefined ? {collateral} : {}), ttlSeconds: 600}),
    },
    nowMs,
    fetchImpl,
  ).pipe(
    Effect.map((body) => {
      const b = (body ?? {}) as {transactions?: unknown; skipped?: unknown; refundSkipped?: unknown}
      const txs = Array.isArray(b.transactions) ? b.transactions : []
      return {
        transactions: txs.map((t): CancelTransaction => {
          const o = (t ?? {}) as Record<string, unknown>
          const refs = Array.isArray(o.cancelledRefs) ? o.cancelledRefs : []
          return {
            ...parseBuilt(t),
            plutusVersion: typeof o.plutusVersion === 'string' ? o.plutusVersion : '',
            cancelledRefs: refs.map(parseRef).filter((r): r is OrderRef => r !== null),
          }
        }),
        skipped: (Array.isArray(b.skipped) ? b.skipped : [])
          .map(parseSkipped)
          .filter((s): s is SkippedOrder => s !== null),
        refundSkipped: (Array.isArray(b.refundSkipped) ? b.refundSkipped : [])
          .map(parseSkipped)
          .filter((s): s is RefundSkipped => s !== null),
      }
    }),
  )

/**
 * ⚠️ Fetched KEYLESS, and deliberately not through `steelswapAuthedJson`.
 *
 * `/api/v2/batcher/status` is documented as public — *"this endpoint is public —
 * it needs no credential, so a status page can poll it directly"* — and verified
 * so live. Sending the bearer spent a request against a per-key daily quota for
 * nothing, AND parked this call behind the shared 429 backoff, so the one screen
 * that explains why swaps are degraded went dark exactly when it was needed.
 */
const fetchBatcherStatus = (
  _nowMs: number,
  fetchImpl: FetchLike = defaultFetch,
): Effect.Effect<readonly BatcherProtocol[], SteelswapError> =>
  publicJson(config(), '/api/v2/batcher/status', fetchImpl).pipe(
    Effect.map((body) => {
      const protocols = (body as {protocols?: unknown}).protocols
      if (!Array.isArray(protocols)) return []
      return protocols.map((p) => {
        const o = (p ?? {}) as Record<string, unknown>
        return {
          protocol: typeof o.protocol === 'string' ? o.protocol : '',
          // Absent for a protocol never snapshotted — missing data, not an error.
          status: str(o.status),
          lastClearedSlot: num(o.lastClearedSlot),
          demandCount: num(o.demandCount),
          oldestDemandAgeBlocks: num(o.oldestDemandAgeBlocks),
          warnThresholdBlocks: num(o.warnThresholdBlocks),
          downThresholdBlocks: num(o.downThresholdBlocks),
        }
      })
    }),
  )

export const steelswapV2: SwapProvider = {
  fetchEstimate,
  buildSwap,
  notifySwap,
  fetchOrder,
  fetchOrders,
  cancelSwap,
  fetchBatcherStatus,
}
