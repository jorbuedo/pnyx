/**
 * Debounced SteelSwap quote for the swap screen. Re-quotes when the pair, the
 * fixed side, the amount or the options change (350ms debounce), exposing the
 * estimate + loading/error so the UI can show live output, rate and fees.
 * Quotes are transient (prices move), so nothing is cached here.
 *
 * Either side can be the fixed one: `exactIn` predicts what you receive,
 * `exactOut` predicts what you must offer. Sending both, or neither, is a 422 —
 * the `SwapSide` union makes that unrepresentable.
 *
 * @module
 */

import {Effect} from 'effect'
import {useEffect, useState} from 'react'
import {fetchEstimate, type SwapEstimate} from '../services/cardano-swap/client'
import {assetIdToSwapUnit} from '../services/cardano-swap/swap-asset'
import type {SwapSide} from '../services/cardano-swap/types'

const DEBOUNCE_MS = 350

export type SwapQuoteError =
  /** The pair is not routable at this size. */
  | 'no_route'
  /** SteelSwap's shared 429 backoff is parked — the quota is daily, so "retry shortly" would be wrong by hours. */
  | 'throttled'
  /** The aggregator's chain backend is unreachable; every pair fails identically. */
  | 'chain_unavailable'
  /** The `allInclusive` total does not cover the fixed overhead. */
  | 'insufficient_input'
  /** No credential — no identity yet, so pricing cannot authenticate. */
  | 'no_credential'
  | 'failed'

export type SwapQuoteState = {
  readonly estimate: SwapEstimate | null
  readonly loading: boolean
  readonly error: SwapQuoteError | null
}

export type SwapQuoteInput = {
  readonly inputAssetId: string
  readonly outputAssetId: string
  /** Base-unit amount of whichever side is fixed. */
  readonly amountBaseUnits: bigint
  readonly fixed: 'in' | 'out'
  /** Treat an ADA input as the total leaving the wallet. `exactIn` + ADA only. */
  readonly allInclusive?: boolean
  /** Makes the babel-fee block wallet-aware rather than a blind preview. */
  readonly addressSource?: string
}

/**
 * Classify a failed quote from the machine code the API sends, falling back to
 * the status only when there is no code. Reading the code rather than
 * substring-matching the message is what keeps this working when copy changes.
 */
export const classifyQuoteError = (e: {
  readonly reason: string
  readonly code?: string | null
  readonly status?: number | null
}): SwapQuoteError => {
  switch (e.code) {
    case 'no_route':
      return 'no_route'
    case 'chain_unavailable':
      return 'chain_unavailable'
    case 'insufficient_input':
      return 'insufficient_input'
    default:
      break
  }
  if (e.reason.includes('backoff') || e.status === 429) return 'throttled'
  if (e.reason.includes('no signer registered')) return 'no_credential'
  if (e.status === 404 || e.status === 422) return 'no_route'
  return 'failed'
}

export const useSwapQuote = (input: SwapQuoteInput): SwapQuoteState => {
  const [state, setState] = useState<SwapQuoteState>({estimate: null, loading: false, error: null})

  const inputUnit = assetIdToSwapUnit(input.inputAssetId)
  const outputUnit = assetIdToSwapUnit(input.outputAssetId)
  const amount = input.amountBaseUnits.toString()
  const {fixed, allInclusive, addressSource} = input

  useEffect(() => {
    if (inputUnit === null || outputUnit === null || inputUnit === outputUnit || amount === '0' || amount === '') {
      setState({estimate: null, loading: false, error: null})
      return
    }
    const side: SwapSide =
      fixed === 'in'
        ? {kind: 'exactIn', inputUnit, amount, outputUnit}
        : {kind: 'exactOut', inputUnit, outputUnit, amount}

    let active = true
    setState((s) => ({...s, loading: true, error: null}))
    const timer = setTimeout(() => {
      void Effect.runPromise(
        Effect.either(
          fetchEstimate(side, Date.now(), {
            ...(allInclusive === true ? {allInclusive: true} : {}),
            ...(addressSource !== undefined ? {addressSource} : {}),
          }),
        ),
      ).then((res) => {
        if (!active) return
        if (res._tag === 'Right') {
          setState({estimate: res.right, loading: false, error: null})
        } else {
          setState({estimate: null, loading: false, error: classifyQuoteError(res.left)})
        }
      })
    }, DEBOUNCE_MS)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [inputUnit, outputUnit, amount, fixed, allInclusive, addressSource])

  return state
}
