/**
 * Chain-specific key derivation configurations.
 *
 * Each blockchain uses different derivation paths based on various standards:
 * - BIP44: m/44'/coin_type'/account'/change/index (Midnight and most chains)
 * - CIP1852: m/1852'/1815'/... (Cardano)
 *
 * Midnight (BIP-44, secp256k1) and Cardano (CIP-1852, Ed25519) both carry a
 * derivation config: Midnight backs the forum identity, Cardano is the primary
 * chain of funds wallets. Other chains (BTC/EVM/SOL) are derive-only xpubs with
 * no first-class config here.
 *
 * @module
 */

import {CARDANO_MAINNET, type ChainId, MIDNIGHT_MAINNET} from '@pnyx/config'
import type {HardwareDeviceType} from '../types.js'

/**
 * Derivation standard used for key derivation.
 */
export type DerivationStandard = 'bip44' | 'bip49' | 'bip84' | 'cip1852' | 'slip10'

/**
 * Configuration for chain-specific key derivation.
 */
export type DerivationConfig = {
  /** BIP44 purpose (44 for standard, 49 for SegWit-compatible, 84 for native SegWit, 1852 for Cardano) */
  readonly purpose: number
  /** Coin type as defined in SLIP-44 */
  readonly coinType: number
  /** The derivation standard this chain follows */
  readonly standard: DerivationStandard
  /** Whether this chain uses extended public keys (xpub) for address derivation */
  readonly usesXPub: boolean
  /** Account gap limit for discovery */
  readonly accountGapLimit: number
  /** Address gap limit for discovery */
  readonly addressGapLimit: number
}

/**
 * SLIP-44 coin types.
 * @see https://github.com/satoshilabs/slips/blob/master/slip-0044.md
 */
export const COIN_TYPES = {
  midnight: 2400, // Midnight's registered SLIP-44 coin type
  cardano: 1815, // Cardano (CIP-1852)
} as const

/**
 * Derivation configurations for all supported chains.
 *
 * Partial: chains without an entry are unsupported and make
 * {@link getDerivationConfig} throw (BTC/EVM/SOL are derive-only xpubs, not
 * first-class group chains here).
 */
export const DERIVATION_CONFIGS: Partial<Record<ChainId, DerivationConfig>> = {
  // Midnight — generic secp256k1 BIP-32 at m/44'/2400'
  [MIDNIGHT_MAINNET]: {
    purpose: 44,
    coinType: COIN_TYPES.midnight,
    standard: 'bip44',
    usesXPub: true,
    accountGapLimit: 1,
    addressGapLimit: 20,
  },
  // Cardano — CIP-1852 Ed25519 at m/1852'/1815' (primary chain of funds wallets)
  [CARDANO_MAINNET]: {
    purpose: 1852,
    coinType: COIN_TYPES.cardano,
    standard: 'cip1852',
    usesXPub: true,
    accountGapLimit: 1,
    addressGapLimit: 20,
  },
}

/**
 * Get the derivation configuration for a chain.
 * @throws Error if chainId is not in DERIVATION_CONFIGS (e.g. Cardano, whose derivation was removed)
 */
export const getDerivationConfig = (chainId: ChainId): DerivationConfig => {
  const config = DERIVATION_CONFIGS[chainId]
  if (!config) {
    throw new Error(`No derivation config found for chain: ${chainId}`)
  }
  return config
}

/**
 * Get the full derivation path for a chain.
 * @param chainId - The chain identifier
 * @param accountIndex - Account index (default 0)
 * @param isChange - Whether this is a change address (internal chain)
 * @param addressIndex - Address index
 * @returns The derivation path string (e.g., "m/44'/2400'/0'/0/0")
 */
export const getDerivationPath = (
  chainId: ChainId,
  accountIndex = 0,
  isChange = false,
  addressIndex = 0,
  _deviceType?: HardwareDeviceType,
): string => {
  const config = getDerivationConfig(chainId)
  const change = isChange ? 1 : 0

  // CIP-1852 uses external/internal chain differently
  if (config.standard === 'cip1852') {
    return `m/${config.purpose}'/${config.coinType}'/${accountIndex}'/${change}/${addressIndex}`
  }

  // SLIP-10: all components must be hardened, 4-level path
  if (config.standard === 'slip10') {
    return `m/${config.purpose}'/${config.coinType}'/${accountIndex}'/${change}'`
  }

  // Standard BIP44/49/84 path
  return `m/${config.purpose}'/${config.coinType}'/${accountIndex}'/${change}/${addressIndex}`
}

/**
 * Chain families for grouping chains with similar derivation logic.
 *
 * A family is the set of chains that share an HD derivation subtree — same
 * curve, same coin type, so they share an xpub. Both `midnight` (secp256k1
 * BIP-44) and `cardano` (Ed25519 CIP-1852) carry a derivation config.
 */
export type ChainFamily = 'midnight' | 'cardano'

/**
 * Get the chain family for a chain.
 * @throws Error for chains outside the supported set (Midnight/Cardano).
 */
export const getChainFamily = (chainId: ChainId): ChainFamily => {
  switch (chainId) {
    case MIDNIGHT_MAINNET:
      return 'midnight'

    case CARDANO_MAINNET:
      return 'cardano'

    default:
      throw new Error(`No chain family for chain: ${chainId}`)
  }
}
