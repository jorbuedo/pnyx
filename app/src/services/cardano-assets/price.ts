/**
 * Fiat pricing for ADA + native tokens.
 *
 * - ADA→fiat: **Kraken** (`makeKrakenPriceSource`), the exchange-grade source
 *   for the majors — covers USD/EUR/GBP/AUD (its ADA pairs). Any other currency
 *   prices to `null` — no fiat shown rather than a wrong number.
 * - token→ADA spot: SteelSwap `POST /api/v2/taptools/token/prices` (batch).
 *
 * A token's fiat unit price = spot(ADA) × ADA→fiat. Anything unpriced or an
 * unsupported currency is `null` — never 0.
 *
 * @module
 */

import {Effect} from 'effect'
import type {FiatCurrency} from '../../providers/fiat-currencies'
import {makeKrakenPriceSource} from '../price-history/kraken'
import {asFiatSymbol} from '../price-history/port'
import {assetIdToUnit} from './asset-id'
import type {CardanoAssetsConfig} from './config'
import {fetchTokenAdaPrices} from './steelswap'
import {ADA_ASSET_IDS, type FetchLike} from './token-metadata'

const defaultFetch: FetchLike = (url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<FetchLike>

/**
 * ADA unit price in `currency` via Kraken, or `null` when Kraken has no ADA pair
 * for the currency or the fetch fails. `nowMs` is accepted for signature
 * compatibility (Kraken's spot is always "now"; the cache owns freshness).
 */
export const fetchAdaPrice = (
  currency: FiatCurrency,
  _nowMs: number,
  _config: CardanoAssetsConfig,
  fetchImpl: FetchLike = defaultFetch,
): Effect.Effect<number | null> =>
  Effect.gen(function* () {
    const fiat = asFiatSymbol(currency)
    if (fiat === null) return null
    return yield* Effect.tryPromise({
      try: () => makeKrakenPriceSource(fetchImpl).majorFiatSpot('ADA', fiat),
      catch: () => null,
    }).pipe(Effect.orElseSucceed(() => null))
  })

/**
 * Fiat unit price per token id in `currency`. ADA ids use the ADA rate; each
 * secondary id's ADA spot (SteelSwap) is multiplied by the ADA rate. Ids absent
 * from the map are unpriced (caller treats as no fiat).
 */
export const fetchTokenPrices = (
  ids: readonly string[],
  currency: FiatCurrency,
  nowMs: number,
  config: CardanoAssetsConfig,
  fetchImpl: FetchLike = defaultFetch,
): Effect.Effect<ReadonlyMap<string, number>> =>
  Effect.gen(function* () {
    const out = new Map<string, number>()
    const adaFiat = yield* fetchAdaPrice(currency, nowMs, config, fetchImpl)
    if (adaFiat === null) return out

    const unitById = new Map<string, string>()
    for (const id of ids) {
      if (ADA_ASSET_IDS.has(id)) {
        out.set(id, adaFiat)
        continue
      }
      if (unitById.has(id)) continue
      const unit = assetIdToUnit(id)
      if (unit !== null && unit.length > 0) unitById.set(id, unit)
    }
    if (unitById.size === 0) return out

    const adaByUnit = yield* fetchTokenAdaPrices([...unitById.values()], config, nowMs, fetchImpl).pipe(
      Effect.orElseSucceed(() => new Map<string, number>()),
    )
    for (const [id, unit] of unitById) {
      const spotAda = adaByUnit.get(unit)
      if (spotAda !== undefined) out.set(id, spotAda * adaFiat)
    }
    return out
  })
