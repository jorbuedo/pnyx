/**
 * Chain display information utilities — Midnight-only.
 *
 * Provides chain metadata for UI display (icons, names, symbols).
 *
 * @module
 */

import {type ChainId, MIDNIGHT_MAINNET} from '@pnyx/config'
import {pnyxPalette} from '../theme/palette'

/**
 * Chain display information.
 *
 * Note: For chain icons, use the ChainIcon component from components/icons.
 */
export type ChainInfo = {
  readonly id: ChainId
  readonly name: string
  readonly symbol: string
  readonly family: string
  readonly explorerUrl: string
}

/**
 * Chain information map for all supported chains (Midnight only).
 */
export const CHAIN_INFO: Partial<Record<ChainId, ChainInfo>> = {
  [MIDNIGHT_MAINNET]: {
    id: MIDNIGHT_MAINNET,
    name: 'Midnight',
    symbol: 'NIGHT',
    family: 'Cardano',
    explorerUrl: 'midnight.network',
  },
}

/**
 * Native token decimals per chain.
 */
export const CHAIN_NATIVE_DECIMALS: Partial<Record<ChainId, number>> = {
  [MIDNIGHT_MAINNET]: 6,
}

/**
 * Get the native token decimals for a chain.
 * Throws on unknown chain — silently defaulting would render fees/amounts
 * with the wrong scale.
 */
export const getChainNativeDecimals = (chainId: ChainId): number => {
  const decimals = CHAIN_NATIVE_DECIMALS[chainId]
  if (decimals === undefined) throw new Error(`No native-token decimals configured for chain '${chainId}'`)
  return decimals
}

/**
 * Get chain info. Throws on unknown chain.
 */
export const getChainInfo = (chainId: ChainId): ChainInfo => {
  const info = CHAIN_INFO[chainId]
  if (!info) throw new Error(`No chain info configured for chain '${chainId}'`)
  return info
}

/**
 * Per-chain accent colour used for compact network-indicator dots. Any
 * unknown chain falls back to a neutral palette grey so the UI is never empty.
 */
export const getChainAccentColor = (_chainId: ChainId): string => pnyxPalette.neutral500
