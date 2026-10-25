/**
 * Solana derivation path utilities.
 *
 * Follows BIP-44 with Solana's coin type.
 * Standard path: m/44'/501'/account'/0'
 *
 * Note: Solana uses Ed25519, and all path components are hardened.
 *
 * @module
 */

import {formatDerivationPath, HARDENED, parseDerivationPath} from './shared'

/**
 * Solana coin type (registered at SLIP-44).
 */
export const SOLANA_COIN_TYPE = 501

/**
 * Standard BIP-44 purpose.
 */
export const BIP44_PURPOSE = 44

/**
 * Creates a standard Solana account path: m/44'/501'/account'/0'
 *
 * This is the 4-level path used by Phantom, Solflare, Trezor, and most wallets.
 * All components are hardened due to Ed25519 requirements.
 *
 * @param account - Account index (0-based)
 * @returns Derivation path string
 */
export const solanaAccountPath = (account: number): string =>
  formatDerivationPath([BIP44_PURPOSE + HARDENED, SOLANA_COIN_TYPE + HARDENED, account + HARDENED, HARDENED])

/**
 * Creates a Solana address path: m/44'/501'/account'/change'
 *
 * @param account - Account index (0-based)
 * @param change - Change index (default 0)
 * @returns Derivation path string
 */
export const solanaAddressPath = (account: number, change = 0): string =>
  formatDerivationPath([BIP44_PURPOSE + HARDENED, SOLANA_COIN_TYPE + HARDENED, account + HARDENED, change + HARDENED])

/**
 * Creates the default Solana path (first account).
 *
 * @returns Address derivation path string
 */
export const solanaDefaultPath = (): string => solanaAccountPath(0)

/**
 * Phantom wallet style path: m/44'/501'/account'/0'
 *
 * The most widely used Solana derivation. Same as solanaAccountPath.
 * Use this for: Phantom, Trezor, most dApps and browser extensions.
 *
 * @param account - Account index
 * @returns Derivation path string
 */
export const solanaPhantomPath = (account: number): string => solanaAccountPath(account)

/**
 * Solflare wallet style path: m/44'/501'/account'/change'
 *
 * Solflare supports a custom change index (defaults to 0, same as Phantom).
 * Use this when: importing from Solflare with non-zero change index.
 *
 * @param account - Account index
 * @param change - Change index (default 0)
 * @returns Derivation path string
 */
export const solanaSolflarePath = (account: number, change = 0): string => solanaAddressPath(account, change)

/**
 * Ledger Solana path: m/44'/501'/account'
 *
 * Ledger uses only 3 levels (no change component).
 * Use this for: Ledger hardware wallets only.
 *
 * @param account - Account index
 * @returns Derivation path string
 */
export const solanaLedgerPath = (account: number): string =>
  formatDerivationPath([BIP44_PURPOSE + HARDENED, SOLANA_COIN_TYPE + HARDENED, account + HARDENED])

/**
 * Parses a Solana derivation path and extracts components.
 *
 * @param path - Derivation path string
 * @returns Parsed path components or null if invalid
 */
export const parseSolanaPath = (
  path: string,
): {
  purpose: number
  coinType: number
  account: number
  change?: number
} | null => {
  const components = parseDerivationPath(path)

  if (components.length < 3) return null

  const purpose = (components[0] ?? 0) - HARDENED
  const coinType = (components[1] ?? 0) - HARDENED
  const account = (components[2] ?? 0) - HARDENED

  if (purpose !== BIP44_PURPOSE || coinType !== SOLANA_COIN_TYPE) return null

  // Check if we have a change component (4th level)
  if (components.length >= 4) {
    const change = (components[3] ?? 0) - HARDENED
    return {purpose, coinType, account, change}
  }

  return {purpose, coinType, account}
}

/**
 * Checks if a path is a Solana derivation path.
 *
 * @param path - Derivation path string
 * @returns True if valid Solana path
 */
export const isSolanaPath = (path: string): boolean => parseSolanaPath(path) !== null
