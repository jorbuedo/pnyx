/**
 * Network display helpers.
 *
 * Cardano network names are proper nouns — they read the same in every locale,
 * so they are not translated. Descriptive prose *about* a network (the picker
 * sublabels, the testnet banner) goes through i18n at the call site.
 *
 * @module
 */

import type {Network} from '../config/networks'

/**
 * Display name for the network.
 *
 * @param network - The selected network
 * @param compact - Uppercase short form, for the header pill
 *
 * @example
 * ```ts
 * getNetworkDisplayName('preprod', false) // 'Preprod'
 * getNetworkDisplayName('preprod', true)  // 'PREPROD'
 * ```
 */
export const getNetworkDisplayName = (network: Network, compact: boolean): string => {
  const name = network === 'mainnet' ? 'Mainnet' : network === 'preprod' ? 'Preprod' : 'Preview'
  return compact ? name.toUpperCase() : name
}
