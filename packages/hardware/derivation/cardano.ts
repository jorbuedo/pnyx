/**
 * Cardano derivation path utilities.
 *
 * Follows CIP-1852 for Cardano HD wallets.
 * Standard path: m/1852'/1815'/account'/role/index
 *
 * @module
 */

import {formatDerivationPath, HARDENED, parseDerivationPath} from './shared'

/**
 * Cardano purpose value (CIP-1852).
 */
export const CARDANO_PURPOSE = 1852

/**
 * Cardano coin type (registered at SLIP-44).
 */
export const CARDANO_COIN_TYPE = 1815

/**
 * Cardano derivation roles.
 */
export const CardanoRole = {
  /** External chain for receiving addresses */
  EXTERNAL: 0,
  /** Internal chain for change addresses */
  INTERNAL: 1,
  /** Staking key */
  STAKING: 2,
  /** DRep key (governance) */
  DREP: 3,
  /** Constitutional Committee Cold key */
  CC_COLD: 4,
  /** Constitutional Committee Hot key */
  CC_HOT: 5,
} as const

export type CardanoRole = (typeof CardanoRole)[keyof typeof CardanoRole]

/**
 * Creates a Cardano account path.
 *
 * @param account - Account index (0-based)
 * @returns Account derivation path string
 */
export const cardanoAccountPath = (account: number): string =>
  formatDerivationPath([CARDANO_PURPOSE + HARDENED, CARDANO_COIN_TYPE + HARDENED, account + HARDENED])

/**
 * Creates a Cardano address path.
 *
 * @param account - Account index (0-based)
 * @param role - Address role (external, internal, staking)
 * @param index - Address index
 * @returns Address derivation path string
 */
export const cardanoAddressPath = (account: number, role: CardanoRole, index: number): string =>
  formatDerivationPath([CARDANO_PURPOSE + HARDENED, CARDANO_COIN_TYPE + HARDENED, account + HARDENED, role, index])

/**
 * Creates a Cardano external (receiving) address path.
 *
 * @param account - Account index (0-based)
 * @param index - Address index
 * @returns Address derivation path string
 */
export const cardanoExternalPath = (account: number, index: number): string =>
  cardanoAddressPath(account, CardanoRole.EXTERNAL, index)

/**
 * Creates a Cardano internal (change) address path.
 *
 * @param account - Account index (0-based)
 * @param index - Address index
 * @returns Address derivation path string
 */
export const cardanoInternalPath = (account: number, index: number): string =>
  cardanoAddressPath(account, CardanoRole.INTERNAL, index)

/**
 * Creates a Cardano staking key path.
 *
 * @param account - Account index (0-based)
 * @returns Staking key derivation path string
 */
export const cardanoStakingPath = (account: number): string => cardanoAddressPath(account, CardanoRole.STAKING, 0)

/**
 * Creates a Cardano DRep key path.
 *
 * @param account - Account index (0-based)
 * @returns DRep key derivation path string
 */
export const cardanoDRepPath = (account: number): string => cardanoAddressPath(account, CardanoRole.DREP, 0)

/**
 * Parses a Cardano derivation path and extracts components.
 *
 * @param path - Derivation path string
 * @returns Parsed path components or null if invalid
 */
export const parseCardanoPath = (
  path: string,
): {
  purpose: number
  coinType: number
  account: number
  role: number
  index: number
} | null => {
  const components = parseDerivationPath(path)

  if (components.length < 5) return null

  const purpose = (components[0] ?? 0) - HARDENED
  const coinType = (components[1] ?? 0) - HARDENED
  const account = (components[2] ?? 0) - HARDENED
  const role = components[3] ?? 0
  const index = components[4] ?? 0

  if (purpose !== CARDANO_PURPOSE || coinType !== CARDANO_COIN_TYPE) return null

  return {purpose, coinType, account, role, index}
}

/**
 * Checks if a path is a Cardano derivation path.
 *
 * @param path - Derivation path string
 * @returns True if valid Cardano path
 */
export const isCardanoPath = (path: string): boolean => parseCardanoPath(path) !== null
