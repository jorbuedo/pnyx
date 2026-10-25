/**
 * Account type and operations.
 *
 * @module
 */

import {Effect} from 'effect'
import type {Account, AccountId, Address, AddressChain, ChainId, WalletGroupId} from '../types.js'

/**
 * Default gap limit for BIP44 address discovery.
 */
export const DEFAULT_GAP_LIMIT = 20

/**
 * Create an address chain.
 */
export const createAddressChain = (params: {
  readonly role: 0 | 1
  readonly addresses?: readonly Address[]
  readonly lastUsedIndex?: number
  readonly gapLimit?: number
}): Effect.Effect<AddressChain, never, never> =>
  Effect.succeed({
    role: params.role,
    addresses: params.addresses ?? [],
    lastUsedIndex: params.lastUsedIndex ?? -1,
    gapLimit: params.gapLimit ?? DEFAULT_GAP_LIMIT,
  })

/**
 * Create an account.
 */
export const createAccount = (params: {
  readonly id?: AccountId
  readonly groupId: WalletGroupId
  readonly chainId: ChainId
  readonly index: number
  readonly name?: string
  readonly publicKey: Uint8Array
  readonly externalChain?: AddressChain
  readonly internalChain?: AddressChain
  readonly rewardAddress: string
}): Effect.Effect<Account, never, never> =>
  Effect.gen(function* () {
    const id = params.id ?? (`${params.groupId}-${params.chainId}-${params.index}` as AccountId)
    const name = params.name ?? `Account ${params.index}`

    const externalChain =
      params.externalChain ??
      (yield* createAddressChain({
        role: 0,
      }))

    const internalChain =
      params.internalChain ??
      (yield* createAddressChain({
        role: 1,
      }))

    return {
      id,
      groupId: params.groupId,
      chainId: params.chainId,
      index: params.index,
      name,
      publicKey: params.publicKey,
      externalChain,
      internalChain,
      rewardAddress: params.rewardAddress,
    }
  })

/**
 * Get all addresses from an account (external + internal).
 */
export const getAccountAddresses = (account: Account): Effect.Effect<readonly Address[], never, never> =>
  Effect.succeed([...account.externalChain.addresses, ...account.internalChain.addresses])

/**
 * Get the next unused external address index.
 */
export const getNextExternalIndex = (account: Account): number => account.externalChain.lastUsedIndex + 1

/**
 * Get the next unused internal (change) address index.
 */
export const getNextInternalIndex = (account: Account): number => account.internalChain.lastUsedIndex + 1

/**
 * Update the last used index for external chain.
 */
export const updateExternalLastUsed = (account: Account, lastUsedIndex: number): Effect.Effect<Account, never, never> =>
  Effect.succeed({
    ...account,
    externalChain: {
      ...account.externalChain,
      lastUsedIndex,
    },
  })

/**
 * Update the last used index for internal chain.
 */
export const updateInternalLastUsed = (account: Account, lastUsedIndex: number): Effect.Effect<Account, never, never> =>
  Effect.succeed({
    ...account,
    internalChain: {
      ...account.internalChain,
      lastUsedIndex,
    },
  })

/**
 * Add addresses to external chain.
 */
export const addExternalAddresses = (
  account: Account,
  addresses: readonly Address[],
): Effect.Effect<Account, never, never> =>
  Effect.succeed({
    ...account,
    externalChain: {
      ...account.externalChain,
      addresses: [...account.externalChain.addresses, ...addresses],
    },
  })

/**
 * Add addresses to internal chain.
 */
export const addInternalAddresses = (
  account: Account,
  addresses: readonly Address[],
): Effect.Effect<Account, never, never> =>
  Effect.succeed({
    ...account,
    internalChain: {
      ...account.internalChain,
      addresses: [...account.internalChain.addresses, ...addresses],
    },
  })
