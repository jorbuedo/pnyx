/**
 * BIP44 address discovery.
 *
 * Implements the gap limit algorithm for discovering used addresses.
 *
 * @module
 */

import {Effect} from 'effect'
import {AddressDiscoveryError} from '../errors.js'
import type {AddressChain} from '../types.js'
import {DEFAULT_GAP_LIMIT} from './account.js'
import type {Address, AddressGenerator, AddressRole} from './address-generator.js'

/**
 * Address discovery result.
 */
export type AddressDiscoveryResult = {
  readonly addresses: readonly Address[]
  readonly lastUsedIndex: number
  readonly usedAddresses: ReadonlySet<string>
}

/**
 * Function to check if addresses have been used on chain.
 */
export type AddressUsageChecker = (addresses: readonly string[]) => Effect.Effect<ReadonlySet<string>, Error>

/**
 * Discover addresses using the BIP44 gap limit algorithm.
 *
 * The algorithm:
 * 1. Start from index 0
 * 2. Generate `gapLimit` addresses
 * 3. Check which addresses have been used
 * 4. If any address in the batch is used, continue from after the last used
 * 5. Stop when we've seen `gapLimit` consecutive unused addresses
 *
 * @param generator - Address generator for the chain being discovered
 * @param role - Address role (0 = external, 1 = internal)
 * @param checkUsage - Function to check address usage on chain
 * @param gapLimit - Number of consecutive unused addresses to stop at
 */
export const discoverAddresses = (
  generator: AddressGenerator,
  role: 0 | 1,
  checkUsage: AddressUsageChecker,
  gapLimit: number = DEFAULT_GAP_LIMIT,
): Effect.Effect<AddressDiscoveryResult, AddressDiscoveryError, never> =>
  Effect.gen(function* () {
    const allAddresses: Address[] = []
    const usedAddresses = new Set<string>()
    let lastUsedIndex = -1
    let currentIndex = 0
    let consecutiveUnused = 0

    while (consecutiveUnused < gapLimit) {
      // Generate a batch of addresses
      const batchSize = Math.min(gapLimit, 50) // Cap batch size
      const batch = yield* generator.deriveRange(role as AddressRole, currentIndex, batchSize).pipe(
        Effect.mapError(
          (e) =>
            new AddressDiscoveryError({
              message: `Failed to derive addresses: ${e.message}`,
              cause: e,
            }),
        ),
      )

      // Check which addresses have been used
      const usedInBatch = yield* checkUsage(batch).pipe(
        Effect.mapError(
          (e) =>
            new AddressDiscoveryError({
              message: `Failed to check address usage: ${e.message}`,
              cause: e,
            }),
        ),
      )

      // Process each address in the batch
      for (let i = 0; i < batch.length; i++) {
        const address = batch[i]
        if (!address) continue

        allAddresses.push(address)

        if (usedInBatch.has(address)) {
          usedAddresses.add(address)
          lastUsedIndex = currentIndex + i
          consecutiveUnused = 0
        } else {
          consecutiveUnused++
          if (consecutiveUnused >= gapLimit) {
            break
          }
        }
      }

      currentIndex += batchSize
    }

    return {
      addresses: allAddresses,
      lastUsedIndex,
      usedAddresses,
    }
  })

/**
 * Update an address chain with discovery results.
 */
export const updateChainFromDiscovery = (
  chain: AddressChain,
  result: AddressDiscoveryResult,
): Effect.Effect<AddressChain, never, never> =>
  Effect.succeed({
    ...chain,
    addresses: result.addresses,
    lastUsedIndex: result.lastUsedIndex,
  })

/**
 * Check if the chain needs more addresses generated.
 * Returns true if there are fewer than gapLimit unused addresses after the last used.
 */
export const needsMoreAddresses = (chain: AddressChain): boolean => {
  const unusedAfterLastUsed = chain.addresses.length - (chain.lastUsedIndex + 1)
  return unusedAfterLastUsed < chain.gapLimit
}

/**
 * Calculate how many new addresses to generate.
 */
export const addressesToGenerate = (chain: AddressChain): number => {
  if (!needsMoreAddresses(chain)) return 0
  const unusedAfterLastUsed = chain.addresses.length - (chain.lastUsedIndex + 1)
  return chain.gapLimit - unusedAfterLastUsed
}
