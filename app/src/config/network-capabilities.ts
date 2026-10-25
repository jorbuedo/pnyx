/**
 * What the app is allowed to do on the selected network.
 *
 * One pure rule table so no screen has to re-derive "are we on a testnet".
 * Test funds have no market, so anything price-shaped is off on a testnet —
 * showing a fiat figure or a swap quote there would be a fabricated number,
 * not a degraded one.
 *
 * | network   | isTestnet | showFiat | swapEnabled | priceHistory | adaTicker |
 * |-----------|-----------|----------|-------------|--------------|-----------|
 * | `mainnet` | no        | yes      | yes         | yes          | `ADA`     |
 * | `preprod` | yes       | no       | no          | no           | `tADA`    |
 * | `preview` | yes       | no       | no          | no           | `tADA`    |
 *
 * @module
 */

import type {Network} from '@pnyx/wallet'

/** Ticker for the chain's native asset. Testnet ADA is conventionally `tADA`. */
export type AdaTicker = 'ADA' | 'tADA'

export type NetworkCapabilities = {
  /** Not mainnet — funds are test funds. */
  readonly isTestnet: boolean
  /** Whether fiat values (balances, prices, change %) may be rendered at all. */
  readonly showFiat: boolean
  /** Whether the swap vertical is reachable. */
  readonly swapEnabled: boolean
  /**
   * Whether a price chart may be *attempted*.
   *
   * Distinct from `showFiat`, which governs rendering a figure we have. This governs the fetch: the
   * history sources (Kraken for ADA, SteelSwap OHLCV for tokens) only quote mainnet assets, so on a
   * testnet the request cannot succeed. Left on, the chart mounted, showed a loading skeleton, and
   * then vanished when the empty series came back — a control that appears and withdraws is worse
   * than one that was never offered.
   */
  readonly priceHistory: boolean
  /** Ticker to label the native asset with. */
  readonly adaTicker: AdaTicker
}

const MAINNET: NetworkCapabilities = {
  isTestnet: false,
  showFiat: true,
  swapEnabled: true,
  priceHistory: true,
  adaTicker: 'ADA',
}

const TESTNET: NetworkCapabilities = {
  isTestnet: true,
  showFiat: false,
  swapEnabled: false,
  priceHistory: false,
  adaTicker: 'tADA',
}

/** The capability set for a network. See the table in the module doc. */
export const networkCapabilities = (network: Network): NetworkCapabilities =>
  network === 'mainnet' ? MAINNET : TESTNET

/** Shorthand for the most-asked question. */
export const isTestnetNetwork = (network: Network): boolean => network !== 'mainnet'

/** Native-asset ticker for a network — the single source for `ADA` vs `tADA`. */
export const adaTickerFor = (network: Network): AdaTicker => networkCapabilities(network).adaTicker
