/**
 * `price-history` — historical + current price sourcing and portfolio valuation.
 * Phase 0: the `PriceHistorySource` port, the Kraken adapter (ADA/NIGHT → fiat),
 * the tx-derived balance timeline, and the valuation compose. Later phases add
 * the SteelSwap (token→ADA) and bundled deep-ADA adapters behind the same port.
 *
 * @module
 */

export * from './price-history/balance-timeline'
export {makeKrakenPriceSource} from './price-history/kraken'
export * from './price-history/port'
export * from './price-history/valuation'
