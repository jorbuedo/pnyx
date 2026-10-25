/**
 * Network icon component.
 *
 * A branded chain circle showing the chain's logo on its brand-color background.
 *
 * @module
 */

import {
  BITCOIN_MAINNET,
  CARDANO_MAINNET,
  type ChainId,
  ETHEREUM_MAINNET,
  MIDNIGHT_MAINNET,
  SOLANA_MAINNET,
} from '@pnyx/config'

import {logger} from '../logger'
import {Bitcoin, Cardano, Ethereum, Midnight, Solana} from './icons/networks'

const supportedChains = new Set<ChainId>([
  BITCOIN_MAINNET,
  CARDANO_MAINNET,
  ETHEREUM_MAINNET,
  SOLANA_MAINNET,
  MIDNIGHT_MAINNET,
])

/** Returns true when `NetworkIcon` can render an icon for `chain`. */
export const hasNetworkIcon = (chain: ChainId): boolean => supportedChains.has(chain)

export type NetworkIconProps = {
  chain: ChainId
  size?: number
}

export const NetworkIcon = ({chain, size = 48}: NetworkIconProps) => {
  switch (chain) {
    case BITCOIN_MAINNET:
      return <Bitcoin size={size} />
    case CARDANO_MAINNET:
      return <Cardano size={size} />
    case ETHEREUM_MAINNET:
      return <Ethereum size={size} />
    case SOLANA_MAINNET:
      return <Solana size={size} />
    case MIDNIGHT_MAINNET:
      return <Midnight size={size} />
    default:
      logger.warn('NetworkIcon: no icon for chain, rendering nothing', {origin: 'NetworkIcon', chain})
      return null
  }
}
