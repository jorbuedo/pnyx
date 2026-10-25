/**
 * SteelSwap swap client — the facade the hooks + UI consume, over the keyed
 * `cicdapi/api/v2` surface (`provider-v2`), normalized to `types.ts` shapes.
 *
 * The former `v1` rail (`api.steelswap.io`, `token` header) was removed
 * 2026-07-26: the host returned 500 on every path including `/` and `/health`,
 * and its credential was SteelSwap's own web-frontend token rather than ours, so
 * it was a fallback that could not answer.
 *
 * Limit orders are NOT here — they are a separate keyless order book with its
 * own schemas (`atc-client.ts`).
 *
 * Units are swap-engine units (ADA = `"lovelace"`; see `swap-asset.ts`); amounts
 * are base-unit integer strings.
 *
 * @module
 */

import type {FetchLike} from '../cardano-assets/token-metadata'
import {steelswapV2} from './provider-v2'
import type {BuildSwapParams, EstimateOptions, OrderRef, OrdersQuery, SwapSide} from './types'

export {parseEstimate, quoteChangedEstimate} from './provider-v2'
export type {
  BabelInfo,
  BabelMode,
  BatcherProtocol,
  BuildSwapParams,
  BuiltSwap,
  CancelResult,
  CancelTransaction,
  EstimateOptions,
  OrderRef,
  OrdersPage,
  OrdersQuery,
  RefundSkipped,
  SkippedOrder,
  SwapAmount,
  SwapEstimate,
  SwapLeg,
  SwapOrder,
  SwapProvider,
  SwapSide,
} from './types'

const active = () => steelswapV2

export const fetchEstimate = (side: SwapSide, nowMs: number, options?: EstimateOptions, fetchImpl?: FetchLike) =>
  active().fetchEstimate(side, nowMs, options, fetchImpl)

export const buildSwap = (params: BuildSwapParams, nowMs: number, fetchImpl?: FetchLike) =>
  active().buildSwap(params, nowMs, fetchImpl)

export const notifySwap = (txHash: string, txCbor: string, nowMs: number, fetchImpl?: FetchLike) =>
  active().notifySwap(txHash, txCbor, nowMs, fetchImpl)

export const fetchOrder = (txHash: string, nowMs: number, fetchImpl?: FetchLike) =>
  active().fetchOrder(txHash, nowMs, fetchImpl)

export const fetchOrders = (query: OrdersQuery, nowMs: number, fetchImpl?: FetchLike) =>
  active().fetchOrders(query, nowMs, fetchImpl)

export const cancelSwap = (
  orders: readonly OrderRef[],
  changeAddress: string,
  collateral: readonly string[] | undefined,
  nowMs: number,
  fetchImpl?: FetchLike,
) => active().cancelSwap(orders, changeAddress, collateral, nowMs, fetchImpl)

export const fetchBatcherStatus = (nowMs: number, fetchImpl?: FetchLike) =>
  active().fetchBatcherStatus(nowMs, fetchImpl)
