/**
 * Ethereum derivation path utilities.
 *
 * Follows BIP-44 standard: m/44'/60'/account'/0/index
 *
 * @module
 */

import {formatDerivationPath, HARDENED, parseDerivationPath} from './shared'

/**
 * Ethereum coin type (registered at SLIP-44).
 */
export const ETHEREUM_COIN_TYPE = 60

/**
 * Standard BIP-44 purpose.
 */
export const BIP44_PURPOSE = 44

/**
 * Common EVM chain coin types (SLIP-44).
 */
export const EVMCoinType = {
  /** Ethereum mainnet */
  ETHEREUM: 60,
  /** Ethereum Classic */
  ETHEREUM_CLASSIC: 61,
  /** Binance Smart Chain (uses ETH derivation in practice) */
  BSC: 60,
  /** Polygon (uses ETH derivation) */
  POLYGON: 60,
  /** Avalanche C-Chain (uses ETH derivation) */
  AVALANCHE: 60,
  /** Arbitrum (uses ETH derivation) */
  ARBITRUM: 60,
  /** Optimism (uses ETH derivation) */
  OPTIMISM: 60,
} as const

/**
 * Creates an Ethereum account path.
 *
 * @param account - Account index (0-based)
 * @param coinType - Coin type (default: 60 for ETH)
 * @returns Account derivation path string
 */
export const ethereumAccountPath = (account: number, coinType = ETHEREUM_COIN_TYPE): string =>
  formatDerivationPath([BIP44_PURPOSE + HARDENED, coinType + HARDENED, account + HARDENED])

/**
 * Creates an Ethereum address path.
 *
 * Standard Ethereum path: m/44'/60'/account'/0/index
 *
 * @param account - Account index (0-based)
 * @param index - Address index
 * @param coinType - Coin type (default: 60 for ETH)
 * @returns Address derivation path string
 */
export const ethereumAddressPath = (account: number, index: number, coinType = ETHEREUM_COIN_TYPE): string =>
  formatDerivationPath([BIP44_PURPOSE + HARDENED, coinType + HARDENED, account + HARDENED, 0, index])

/**
 * Creates the default Ethereum path (first account, first address).
 *
 * @returns Address derivation path string
 */
export const ethereumDefaultPath = (): string => ethereumAddressPath(0, 0)

/**
 * Creates a Ledger Live style Ethereum path.
 *
 * Ledger Live uses: m/44'/60'/index'/0/0
 * (index in account position, not address position)
 *
 * @param index - Wallet index
 * @param coinType - Coin type (default: 60 for ETH)
 * @returns Address derivation path string
 */
export const ethereumLedgerLivePath = (index: number, coinType = ETHEREUM_COIN_TYPE): string =>
  formatDerivationPath([BIP44_PURPOSE + HARDENED, coinType + HARDENED, index + HARDENED, 0, 0])

/**
 * Creates a MetaMask/MEW style Ethereum path.
 *
 * Some wallets use: m/44'/60'/0'/0/index
 *
 * @param index - Address index
 * @returns Address derivation path string
 */
export const ethereumMetamaskPath = (index: number): string => ethereumAddressPath(0, index)

/**
 * Creates an Ethereum Classic path.
 *
 * @param account - Account index (0-based)
 * @param index - Address index
 * @returns Address derivation path string
 */
export const ethereumClassicPath = (account: number, index: number): string =>
  ethereumAddressPath(account, index, EVMCoinType.ETHEREUM_CLASSIC)

/**
 * Parses an Ethereum derivation path and extracts components.
 *
 * @param path - Derivation path string
 * @returns Parsed path components or null if invalid
 */
export const parseEthereumPath = (
  path: string,
): {
  purpose: number
  coinType: number
  account: number
  change: number
  index: number
} | null => {
  const components = parseDerivationPath(path)

  if (components.length < 5) return null

  const purpose = (components[0] ?? 0) - HARDENED
  const coinType = (components[1] ?? 0) - HARDENED
  const account = (components[2] ?? 0) - HARDENED
  const change = components[3] ?? 0
  const index = components[4] ?? 0

  // Check for BIP-44 purpose and Ethereum-compatible coin types
  if (purpose !== BIP44_PURPOSE) return null
  if (coinType !== 60 && coinType !== 61) return null

  return {purpose, coinType, account, change, index}
}

/**
 * Checks if a path is an Ethereum derivation path.
 *
 * @param path - Derivation path string
 * @returns True if valid Ethereum path
 */
export const isEthereumPath = (path: string): boolean => parseEthereumPath(path) !== null
