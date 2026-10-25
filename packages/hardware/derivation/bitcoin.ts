/**
 * Bitcoin derivation path utilities.
 *
 * Supports BIP-44 (legacy), BIP-49 (SegWit), and BIP-84 (Native SegWit).
 *
 * @module
 */

import {formatDerivationPath, HARDENED, parseDerivationPath} from './shared'

/**
 * Bitcoin coin type (registered at SLIP-44).
 */
export const BITCOIN_COIN_TYPE = 0

/**
 * Bitcoin testnet coin type.
 */
export const BITCOIN_TESTNET_COIN_TYPE = 1

/**
 * Bitcoin derivation purposes.
 */
export const BitcoinPurpose = {
  /** BIP-44: Legacy P2PKH addresses */
  BIP44: 44,
  /** BIP-49: SegWit P2SH-P2WPKH addresses */
  BIP49: 49,
  /** BIP-84: Native SegWit P2WPKH addresses (bech32) */
  BIP84: 84,
  /** BIP-86: Taproot P2TR addresses */
  BIP86: 86,
} as const

export type BitcoinPurpose = (typeof BitcoinPurpose)[keyof typeof BitcoinPurpose]

/**
 * Bitcoin address types corresponding to purposes.
 */
export const BitcoinAddressType = {
  /** Legacy P2PKH (starts with 1) */
  LEGACY: 'legacy',
  /** SegWit P2SH-P2WPKH (starts with 3) */
  SEGWIT: 'segwit',
  /** Native SegWit P2WPKH (starts with bc1q) */
  NATIVE_SEGWIT: 'native_segwit',
  /** Taproot P2TR (starts with bc1p) */
  TAPROOT: 'taproot',
} as const

export type BitcoinAddressType = (typeof BitcoinAddressType)[keyof typeof BitcoinAddressType]

/**
 * Creates a Bitcoin account path.
 *
 * @param purpose - BIP purpose (44, 49, 84, or 86)
 * @param account - Account index (0-based)
 * @param testnet - Use testnet coin type
 * @returns Account derivation path string
 */
export const bitcoinAccountPath = (purpose: BitcoinPurpose, account: number, testnet = false): string => {
  const coinType = testnet ? BITCOIN_TESTNET_COIN_TYPE : BITCOIN_COIN_TYPE
  return formatDerivationPath([purpose + HARDENED, coinType + HARDENED, account + HARDENED])
}

/**
 * Creates a Bitcoin address path.
 *
 * @param purpose - BIP purpose (44, 49, 84, or 86)
 * @param account - Account index (0-based)
 * @param change - Change chain (0 = external, 1 = internal/change)
 * @param index - Address index
 * @param testnet - Use testnet coin type
 * @returns Address derivation path string
 */
export const bitcoinAddressPath = (
  purpose: BitcoinPurpose,
  account: number,
  change: 0 | 1,
  index: number,
  testnet = false,
): string => {
  const coinType = testnet ? BITCOIN_TESTNET_COIN_TYPE : BITCOIN_COIN_TYPE
  return formatDerivationPath([purpose + HARDENED, coinType + HARDENED, account + HARDENED, change, index])
}

/**
 * Creates a BIP-84 Native SegWit path (most common for modern wallets).
 *
 * @param account - Account index (0-based)
 * @param change - Change chain (0 = external, 1 = internal)
 * @param index - Address index
 * @param testnet - Use testnet coin type
 * @returns Address derivation path string
 */
export const bitcoinNativeSegwitPath = (account: number, change: 0 | 1, index: number, testnet = false): string =>
  bitcoinAddressPath(BitcoinPurpose.BIP84, account, change, index, testnet)

/**
 * Creates a BIP-44 Legacy path.
 *
 * @param account - Account index (0-based)
 * @param change - Change chain (0 = external, 1 = internal)
 * @param index - Address index
 * @param testnet - Use testnet coin type
 * @returns Address derivation path string
 */
export const bitcoinLegacyPath = (account: number, change: 0 | 1, index: number, testnet = false): string =>
  bitcoinAddressPath(BitcoinPurpose.BIP44, account, change, index, testnet)

/**
 * Creates a BIP-86 Taproot path.
 *
 * @param account - Account index (0-based)
 * @param change - Change chain (0 = external, 1 = internal)
 * @param index - Address index
 * @param testnet - Use testnet coin type
 * @returns Address derivation path string
 */
export const bitcoinTaprootPath = (account: number, change: 0 | 1, index: number, testnet = false): string =>
  bitcoinAddressPath(BitcoinPurpose.BIP86, account, change, index, testnet)

/**
 * Gets the purpose value for an address type.
 *
 * @param addressType - Bitcoin address type
 * @returns BIP purpose value
 */
export const purposeForAddressType = (addressType: BitcoinAddressType): BitcoinPurpose => {
  switch (addressType) {
    case BitcoinAddressType.LEGACY:
      return BitcoinPurpose.BIP44
    case BitcoinAddressType.SEGWIT:
      return BitcoinPurpose.BIP49
    case BitcoinAddressType.NATIVE_SEGWIT:
      return BitcoinPurpose.BIP84
    case BitcoinAddressType.TAPROOT:
      return BitcoinPurpose.BIP86
  }
}

/**
 * Parses a Bitcoin derivation path and extracts components.
 *
 * @param path - Derivation path string
 * @returns Parsed path components or null if invalid
 */
export const parseBitcoinPath = (
  path: string,
): {
  purpose: number
  coinType: number
  account: number
  change: number
  index: number
  testnet: boolean
} | null => {
  const components = parseDerivationPath(path)

  if (components.length < 5) return null

  const purpose = (components[0] ?? 0) - HARDENED
  const coinType = (components[1] ?? 0) - HARDENED
  const account = (components[2] ?? 0) - HARDENED
  const change = components[3] ?? 0
  const index = components[4] ?? 0

  const validPurposes = [44, 49, 84, 86]
  const validCoinTypes = [BITCOIN_COIN_TYPE, BITCOIN_TESTNET_COIN_TYPE]

  if (!validPurposes.includes(purpose) || !validCoinTypes.includes(coinType)) return null

  return {
    purpose,
    coinType,
    account,
    change,
    index,
    testnet: coinType === BITCOIN_TESTNET_COIN_TYPE,
  }
}

/**
 * Checks if a path is a Bitcoin derivation path.
 *
 * @param path - Derivation path string
 * @returns True if valid Bitcoin path
 */
export const isBitcoinPath = (path: string): boolean => parseBitcoinPath(path) !== null
