/**
 * TRON derivation path utilities.
 *
 * Follows BIP-44 standard: m/44'/195'/account'/0/index
 *
 * @module
 */

import {formatDerivationPath, HARDENED, parseDerivationPath} from './shared'

/**
 * TRON coin type (registered at SLIP-44).
 */
export const TRON_COIN_TYPE = 195

/**
 * Standard BIP-44 purpose.
 */
export const BIP44_PURPOSE = 44

/**
 * Creates a TRON account path.
 *
 * @param account - Account index (0-based)
 * @returns Account derivation path string
 */
export const tronAccountPath = (account: number): string =>
  formatDerivationPath([BIP44_PURPOSE + HARDENED, TRON_COIN_TYPE + HARDENED, account + HARDENED])

/**
 * Creates a TRON address path.
 *
 * Standard TRON path: m/44'/195'/account'/0/index
 *
 * @param account - Account index (0-based)
 * @param index - Address index
 * @returns Address derivation path string
 */
export const tronAddressPath = (account: number, index: number): string =>
  formatDerivationPath([BIP44_PURPOSE + HARDENED, TRON_COIN_TYPE + HARDENED, account + HARDENED, 0, index])

/**
 * Creates the default TRON path (first account, first address).
 *
 * @returns Address derivation path string
 */
export const tronDefaultPath = (): string => tronAddressPath(0, 0)

/**
 * Creates a TronLink wallet style TRON path.
 *
 * TronLink uses: m/44'/195'/0'/0/index
 *
 * @param index - Address index
 * @returns Address derivation path string
 */
export const tronLinkPath = (index: number): string => tronAddressPath(0, index)

/**
 * Creates a Ledger TRON path.
 *
 * Ledger uses: m/44'/195'/account'/0/0
 *
 * @param account - Account index
 * @returns Address derivation path string
 */
export const tronLedgerPath = (account: number): string => tronAddressPath(account, 0)

/**
 * Parses a TRON derivation path and extracts components.
 *
 * @param path - Derivation path string
 * @returns Parsed path components or null if invalid
 */
export const parseTronPath = (
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

  if (purpose !== BIP44_PURPOSE || coinType !== TRON_COIN_TYPE) return null

  return {purpose, coinType, account, change, index}
}

/**
 * Checks if a path is a TRON derivation path.
 *
 * @param path - Derivation path string
 * @returns True if valid TRON path
 */
export const isTronPath = (path: string): boolean => parseTronPath(path) !== null
