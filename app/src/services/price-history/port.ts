/**
 * `PriceHistorySource` — the single seam every price backend plugs into, so the
 * app's value/chart/per-tx-fiat logic never knows which upstream served a point.
 * Phase 0 ships the Kraken adapter (ADA & NIGHT → fiat); Phase 2 adds a SteelSwap
 * adapter (token → ADA) and a bundled deep-history adapter behind the same shape.
 *
 * All timestamps are **unix seconds**. Series are the **close** price per point,
 * ascending by `ts`; callers resample to a chart resolution. A source returns an
 * empty series (never a fabricated point) for a window it can't cover.
 *
 * @module
 */

/** The fiats Kraken lists an ADA pair for (ADA/USD, /EUR, /GBP, /AUD). */
export type FiatSymbol = 'USD' | 'EUR' | 'GBP' | 'AUD'

/** Every {@link FiatSymbol}, in display order — the app's priceable fiat set. */
export const FIAT_SYMBOLS: readonly FiatSymbol[] = ['USD', 'EUR', 'GBP', 'AUD']

/** Narrow an app currency code to a Kraken-priceable {@link FiatSymbol}, else `null`. */
export const asFiatSymbol = (currency: string): FiatSymbol | null =>
  (FIAT_SYMBOLS as readonly string[]).includes(currency) ? (currency as FiatSymbol) : null

/**
 * The only asset we price in fiat directly via Kraken. Every other Cardano
 * token — NIGHT included — is priced as a native token (token→ADA via SteelSwap)
 * composed with ADA→fiat, so it never needs an exchange listing.
 */
export type MajorAsset = 'ADA'

/** One close-price point. `ts` = unix seconds; `value` = price in the series' unit. */
export type PricePoint = {readonly ts: number; readonly value: number}

export type PriceHistorySource = {
  /**
   * Close-price series for a major asset in `fiat` over `[fromSec, toSec]`
   * (inclusive), ascending. The adapter picks a native granularity for the span;
   * the caller resamples. Empty when the pair/window isn't available.
   */
  readonly majorFiatSeries: (
    asset: MajorAsset,
    fiat: FiatSymbol,
    fromSec: number,
    toSec: number,
  ) => Promise<readonly PricePoint[]>

  /** Current close price for a major asset in `fiat`, or `null` if unavailable. */
  readonly majorFiatSpot: (asset: MajorAsset, fiat: FiatSymbol) => Promise<number | null>
}

/** Minimal fetch shape (matches the cardano-assets adapters; DI'd for tests). */
export type FetchLike = (
  url: string,
  init?: {method?: string; headers?: Record<string, string>; body?: string},
) => Promise<{ok: boolean; status: number; json: () => Promise<unknown>}>
