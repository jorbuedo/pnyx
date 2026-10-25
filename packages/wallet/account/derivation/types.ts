/**
 * Shared address-derivation types used by all per-chain generators.
 *
 * @module
 */

import type {ChainId} from '@pnyx/config'
import type {Effect} from 'effect'
import type {DerivationError} from '../../errors.js'

/**
 * Generic address type for multi-chain support.
 */
export type Address = string

/**
 * Address role in derivation.
 * 0 = external (receive), 1 = internal (change), 2 = staking (Cardano only)
 */
export type AddressRole = 0 | 1 | 2

/**
 * Address generator for deriving addresses from account public key.
 */
export type AddressGenerator = {
  /** The chain this generator is for */
  readonly chainId: ChainId

  /** Derive address at given role and index */
  readonly derive: (role: AddressRole, index: number) => Effect.Effect<Address, DerivationError>

  /** Derive multiple addresses in range */
  readonly deriveRange: (
    role: AddressRole,
    start: number,
    count: number,
  ) => Effect.Effect<readonly Address[], DerivationError>

  /** Get reward/staking address (only applicable for some chains like Cardano) */
  readonly getRewardAddress: () => Effect.Effect<Address | null, DerivationError>

  /** Whether this chain supports multiple addresses per account */
  readonly supportsMultipleAddresses: boolean

  /** Whether this chain has a separate staking/reward address */
  readonly hasRewardAddress: boolean
}
