/**
 * In-memory handoff from the swap quote screen to the swap review screen. The
 * live estimate (route split, fees, price impact) is not router-serializable and
 * must be the *exact* quote the user saw — re-quoting on the review screen would
 * show a different price — so the quote screen registers an intent and navigates
 * with its id; the review screen claims it by id.
 *
 * Single-consumer, evicted on settle/cancel — a backgrounded or duplicate mount
 * can't act on a stale quote.
 *
 * @module
 */

import type {SwapEstimate} from '../../services/cardano-swap/client'

/** One side of the pair — id (app asset id, ADA = `''`), decimals, display label. */
export type SwapSide = {readonly id: string; readonly decimals: number; readonly label: string}

export type SwapIntent = {
  readonly from: SwapSide
  readonly to: SwapSide
  /** Input amount in `from`'s base units. */
  readonly amountBaseUnits: bigint
  /** The exact estimate the user reviewed. */
  readonly estimate: SwapEstimate
  /** Max slippage the user accepts, in basis points. */
  readonly slippageBps: number
  /**
   * Review ticket id for the already-built tx. The build runs on the quote
   * screen (inputs still editable); the review screen only enters the shared
   * ceremony with this ticket on confirm.
   */
  readonly ticketId: string
}

const intents = new Map<string, SwapIntent>()
let counter = 0

/** Register an intent; returns the id to pass as the `intent` route param. */
export const registerSwapIntent = (intent: SwapIntent): string => {
  counter += 1
  const id = `swp_${counter}`
  intents.set(id, intent)
  return id
}

/** Read an intent without consuming it (the review screen reads on mount). */
export const peekSwapIntent = (id: string): SwapIntent | undefined => intents.get(id)

/** Consume + remove an intent once it has been acted on. */
export const consumeSwapIntent = (id: string): SwapIntent | undefined => {
  const intent = intents.get(id)
  intents.delete(id)
  return intent
}
