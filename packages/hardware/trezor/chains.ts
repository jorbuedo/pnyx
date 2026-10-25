/**
 * Trezor chain support.
 *
 * Defines which blockchain chains are supported by Trezor hardware wallets.
 * Unlike Ledger, Trezor handles app switching automatically via TrezorConnect.
 *
 * @module
 */

import {
  ARBITRUM_ONE,
  AVALANCHE_MAINNET,
  BASE_MAINNET,
  BINANCE_MAINNET,
  BITCOIN_CASH_MAINNET,
  BITCOIN_MAINNET,
  CARDANO_MAINNET,
  type ChainId,
  DOGECOIN_MAINNET,
  ETHEREUM_MAINNET,
  LITECOIN_MAINNET,
  OPTIMISM_MAINNET,
  POLYGON_MAINNET,
  SOLANA_MAINNET,
} from '@pnyx/config'

/**
 * Chains supported by Trezor hardware wallets.
 *
 * Trezor handles app switching automatically via TrezorConnect,
 * so no manual app switching is needed during wallet import.
 */
export const SUPPORTED_CHAINS: readonly ChainId[] = [
  CARDANO_MAINNET,
  BITCOIN_MAINNET,
  LITECOIN_MAINNET,
  DOGECOIN_MAINNET,
  BITCOIN_CASH_MAINNET,
  ETHEREUM_MAINNET,
  POLYGON_MAINNET,
  ARBITRUM_ONE,
  OPTIMISM_MAINNET,
  AVALANCHE_MAINNET,
  BINANCE_MAINNET,
  BASE_MAINNET,
  SOLANA_MAINNET,
] as const

/**
 * Check if a chain is supported by Trezor.
 *
 * @param chainId - The chain identifier
 * @returns True if the chain is supported
 */
export const isChainSupported = (chainId: ChainId): boolean => {
  return (SUPPORTED_CHAINS as readonly string[]).includes(chainId)
}
