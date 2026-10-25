/**
 * The ATC reference price for an ADA-paired market — what a limit price should
 * be judged against.
 *
 * A limit price with nothing to compare it to is a guess, so this seeds the
 * field and shows how far the typed price sits from the market.
 *
 * Notes the API forces on us:
 * - **One leg must be ADA**, and both legs need known decimals, or it is a 422.
 * - ⚠️ **A large `ageS` is NOT an error.** A QUIET pair is not stale, so age is
 *   reported as data; only `503` (indexer trailing / upstream timeout) and `502`
 *   mean the price could not be read.
 * - Keyless, like the rest of ATC.
 *
 * @module
 */

import {Effect} from 'effect'
import {useEffect, useState} from 'react'
import {logger} from '../logger'
import {type AtcQuote, fetchAtcQuote} from '../services/cardano-swap/atc-client'

const DEBOUNCE_MS = 350

export type AtcReferenceState = {
  readonly quote: AtcQuote | null
  readonly loading: boolean
  /** `unavailable` when the pair has no readable price; `stale` when the indexer is behind. */
  readonly error: 'unavailable' | 'stale' | null
}

export type AtcReferenceInput = {
  readonly offerUnit: string | null
  readonly askUnit: string | null
  /**
   * Base units to price. Pass a NOMINAL amount (one whole unit) to read the rate
   * before the user has typed one — the price is per-unit, and quoting at the
   * real size later is what surfaces `insufficientDepth`.
   */
  readonly offerAmount: string
  readonly enabled: boolean
}

export const useAtcReferenceQuote = (input: AtcReferenceInput): AtcReferenceState => {
  const [state, setState] = useState<AtcReferenceState>({quote: null, loading: false, error: null})
  const {offerUnit, askUnit, offerAmount, enabled} = input

  useEffect(() => {
    if (!enabled || offerUnit === null || askUnit === null || offerUnit === askUnit || offerAmount === '0') {
      setState({quote: null, loading: false, error: null})
      return
    }
    let active = true
    setState((s) => ({...s, loading: true}))
    const timer = setTimeout(() => {
      void Effect.runPromise(Effect.either(fetchAtcQuote(offerUnit, offerAmount, askUnit))).then((res) => {
        if (!active) return
        if (res._tag === 'Right') {
          setState({quote: res.right, loading: false, error: null})
          return
        }
        logger.warn('ATC reference price unavailable; the limit field has no market to anchor to', {
          origin: 'useAtcReferenceQuote',
          error: res.left.reason,
          code: res.left.code ?? null,
        })
        setState({
          quote: null,
          loading: false,
          // 503 is the indexer trailing the chain — a real "try again", unlike a
          // pair that simply has no on-chain price.
          error: res.left.status === 503 ? 'stale' : 'unavailable',
        })
      })
    }, DEBOUNCE_MS)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [offerUnit, askUnit, offerAmount, enabled])

  return state
}

/**
 * The reference rate as ASK per ONE whole OFFER token, or `null` when it cannot
 * be derived.
 *
 * Derived from the quote's own `offer` / `ask` amounts rather than its `price`
 * string: those two are unambiguous base-unit quantities in units we already
 * know the scale of, whereas `price` carries no stated denomination.
 */
export const atcRatePerOfferUnit = (quote: AtcQuote, offerDecimals: number, askDecimals: number): number | null => {
  const offer = Number(quote.offer.amount)
  const ask = Number(quote.ask.amount)
  if (!Number.isFinite(offer) || !Number.isFinite(ask) || offer <= 0) return null
  const offerWhole = offer / 10 ** offerDecimals
  const askWhole = ask / 10 ** askDecimals
  if (offerWhole <= 0) return null
  return askWhole / offerWhole
}
