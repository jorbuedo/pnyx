import {describe, expect, it} from '@effect/vitest'
import {Effect} from 'effect'
import type {AccountId, Address, ChainId, WalletGroupId} from '../types.js'
import {
  addExternalAddresses,
  addInternalAddresses,
  createAccount,
  createAddressChain,
  DEFAULT_GAP_LIMIT,
  getAccountAddresses,
  getNextExternalIndex,
  getNextInternalIndex,
  updateExternalLastUsed,
  updateInternalLastUsed,
} from './account.js'

describe('account', () => {
  const testGroupId = 'test-wallet' as WalletGroupId
  const testChainId = 'cardano' as ChainId
  const testPublicKey = new Uint8Array(32).fill(1)

  describe('createAddressChain', () => {
    it.effect('creates chain with default values', () =>
      Effect.gen(function* () {
        const chain = yield* createAddressChain({role: 0})
        expect(chain.role).toBe(0)
        expect(chain.addresses).toEqual([])
        expect(chain.lastUsedIndex).toBe(-1)
        expect(chain.gapLimit).toBe(DEFAULT_GAP_LIMIT)
      }),
    )

    it.effect('creates chain with custom values', () =>
      Effect.gen(function* () {
        const chain = yield* createAddressChain({
          role: 1,
          addresses: ['addr1' as Address, 'addr2' as Address],
          lastUsedIndex: 5,
          gapLimit: 10,
        })
        expect(chain.role).toBe(1)
        expect(chain.addresses).toHaveLength(2)
        expect(chain.lastUsedIndex).toBe(5)
        expect(chain.gapLimit).toBe(10)
      }),
    )
  })

  describe('createAccount', () => {
    it.effect('creates account with auto-generated id', () =>
      Effect.gen(function* () {
        const account = yield* createAccount({
          groupId: testGroupId,
          chainId: testChainId,
          index: 0,
          publicKey: testPublicKey,
          rewardAddress: 'stake1...',
        })
        expect(account.id).toBe(`${testGroupId}-${testChainId}-0`)
        expect(account.groupId).toBe(testGroupId)
        expect(account.index).toBe(0)
        expect(account.name).toBe('Account 0')
      }),
    )

    it.effect('creates account with custom id and name', () =>
      Effect.gen(function* () {
        const customId = 'my-custom-id' as AccountId
        const account = yield* createAccount({
          id: customId,
          groupId: testGroupId,
          chainId: testChainId,
          index: 1,
          name: 'My Savings',
          publicKey: testPublicKey,
          rewardAddress: 'stake1...',
        })
        expect(account.id).toBe(customId)
        expect(account.name).toBe('My Savings')
      }),
    )

    it.effect('creates account with default chains', () =>
      Effect.gen(function* () {
        const account = yield* createAccount({
          groupId: testGroupId,
          chainId: testChainId,
          index: 0,
          publicKey: testPublicKey,
          rewardAddress: 'stake1...',
        })
        expect(account.externalChain.role).toBe(0)
        expect(account.internalChain.role).toBe(1)
      }),
    )
  })

  describe('getAccountAddresses', () => {
    it.effect('returns combined addresses from both chains', () =>
      Effect.gen(function* () {
        const externalChain = yield* createAddressChain({
          role: 0,
          addresses: ['ext1' as Address, 'ext2' as Address],
        })
        const internalChain = yield* createAddressChain({
          role: 1,
          addresses: ['int1' as Address],
        })
        const account = yield* createAccount({
          groupId: testGroupId,
          chainId: testChainId,
          index: 0,
          publicKey: testPublicKey,
          externalChain,
          internalChain,
          rewardAddress: 'stake1...',
        })
        const addresses = yield* getAccountAddresses(account)
        expect(addresses).toHaveLength(3)
      }),
    )
  })

  describe('getNextExternalIndex', () => {
    it.effect('returns next index after last used', () =>
      Effect.gen(function* () {
        const externalChain = yield* createAddressChain({
          role: 0,
          lastUsedIndex: 4,
        })
        const account = yield* createAccount({
          groupId: testGroupId,
          chainId: testChainId,
          index: 0,
          publicKey: testPublicKey,
          externalChain,
          rewardAddress: 'stake1...',
        })
        expect(getNextExternalIndex(account)).toBe(5)
      }),
    )
  })

  describe('getNextInternalIndex', () => {
    it.effect('returns next index after last used', () =>
      Effect.gen(function* () {
        const internalChain = yield* createAddressChain({
          role: 1,
          lastUsedIndex: 2,
        })
        const account = yield* createAccount({
          groupId: testGroupId,
          chainId: testChainId,
          index: 0,
          publicKey: testPublicKey,
          internalChain,
          rewardAddress: 'stake1...',
        })
        expect(getNextInternalIndex(account)).toBe(3)
      }),
    )
  })

  describe('updateExternalLastUsed', () => {
    it.effect('updates last used index for external chain', () =>
      Effect.gen(function* () {
        const account = yield* createAccount({
          groupId: testGroupId,
          chainId: testChainId,
          index: 0,
          publicKey: testPublicKey,
          rewardAddress: 'stake1...',
        })
        const updated = yield* updateExternalLastUsed(account, 10)
        expect(updated.externalChain.lastUsedIndex).toBe(10)
        expect(updated.internalChain.lastUsedIndex).toBe(-1)
      }),
    )
  })

  describe('updateInternalLastUsed', () => {
    it.effect('updates last used index for internal chain', () =>
      Effect.gen(function* () {
        const account = yield* createAccount({
          groupId: testGroupId,
          chainId: testChainId,
          index: 0,
          publicKey: testPublicKey,
          rewardAddress: 'stake1...',
        })
        const updated = yield* updateInternalLastUsed(account, 5)
        expect(updated.internalChain.lastUsedIndex).toBe(5)
        expect(updated.externalChain.lastUsedIndex).toBe(-1)
      }),
    )
  })

  describe('addExternalAddresses', () => {
    it.effect('adds addresses to external chain', () =>
      Effect.gen(function* () {
        const account = yield* createAccount({
          groupId: testGroupId,
          chainId: testChainId,
          index: 0,
          publicKey: testPublicKey,
          rewardAddress: 'stake1...',
        })
        const updated = yield* addExternalAddresses(account, ['addr1' as Address, 'addr2' as Address])
        expect(updated.externalChain.addresses).toHaveLength(2)
      }),
    )
  })

  describe('addInternalAddresses', () => {
    it.effect('adds addresses to internal chain', () =>
      Effect.gen(function* () {
        const account = yield* createAccount({
          groupId: testGroupId,
          chainId: testChainId,
          index: 0,
          publicKey: testPublicKey,
          rewardAddress: 'stake1...',
        })
        const updated = yield* addInternalAddresses(account, ['addr1' as Address])
        expect(updated.internalChain.addresses).toHaveLength(1)
      }),
    )
  })
})
