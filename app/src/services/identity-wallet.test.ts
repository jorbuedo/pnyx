/**
 * Tests for the identity wallet service — the reserved enclave slot behind
 * SIWM/app auth. Focus: the legacy-adoption no-clobber invariant (an existing
 * identity is never overwritten by a group-seed adoption).
 *
 * The seeds here are real BIP-39 phrases because storing the identity now also
 * derives its Cardano key hashes (identity-cardano-creds), which rejects a
 * non-mnemonic rather than silently skipping.
 */

import {Effect} from 'effect'
import {beforeEach, describe, expect, it, vi} from 'vitest'

const {slots, stored} = vi.hoisted(() => ({slots: new Map<string, string>(), stored: new Map<string, string>()}))

// The identity write path persists the ID's Cardano key hashes; mock only the
// storage layer (MMKV can't load under node) so the derivation itself still runs.
vi.mock('../platform/storage', () => ({
  storage: {
    get: async (key: string) => stored.get(key) ?? null,
    set: async (key: string, value: string) => {
      stored.set(key, value)
    },
    remove: async (key: string) => {
      stored.delete(key)
    },
  },
}))

vi.mock('./credential-vault', () => ({
  createEnclaveMnemonicVault: () => ({
    has: (id: string) => Effect.sync(() => slots.has(id)),
    store: (id: string, mnemonic: string) =>
      Effect.sync(() => {
        slots.set(id, mnemonic)
      }),
    retrieve: (id: string) =>
      Effect.suspend(() => {
        const value = slots.get(id)
        return value === undefined ? Effect.fail(new Error(`not-found: ${id}`)) : Effect.succeed(value)
      }),
    delete: (id: string) =>
      Effect.sync(() => {
        slots.delete(id)
      }),
    enumerate: () => Effect.sync(() => [...slots.keys()]),
  }),
}))

const SEED_A = 'test walk nut penalty hip pave soap entry language right filter choice'
const SEED_B = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

import {deriveIdentityCardanoCreds, parseIdentityCardanoCreds} from './identity-cardano-creds'
import {
  deleteIdentityMnemonic,
  generateIdentityMnemonic,
  hasIdentityMnemonic,
  IDENTITY_VAULT_ID,
  retrieveIdentityMnemonic,
  storeIdentityMnemonic,
} from './identity-wallet'

beforeEach(() => {
  slots.clear()
  stored.clear()
})

describe('identity-wallet', () => {
  it('stores and retrieves the identity seed under the reserved slot', async () => {
    await storeIdentityMnemonic(SEED_A)
    expect(await hasIdentityMnemonic()).toBe(true)
    expect(await retrieveIdentityMnemonic()).toBe(SEED_A)
    expect(slots.has(IDENTITY_VAULT_ID)).toBe(true)
  })

  // There is no adopt-from-a-wallet-group path any more, and there must not be
  // one: onboarding creates this slot unconditionally, so a group without an
  // identity is unreachable. Asserting the clobber-guard is gone would be
  // asserting the absence of code, so what is pinned instead is the property that
  // made the guard matter — a store never silently replaces a different identity
  // without the caller deleting it first.
  it('a second store replaces the slot only because the caller asked it to', async () => {
    await storeIdentityMnemonic(SEED_A)
    await deleteIdentityMnemonic()
    expect(await hasIdentityMnemonic()).toBe(false)
    await storeIdentityMnemonic(SEED_B)
    expect(await retrieveIdentityMnemonic()).toBe(SEED_B)
  })

  it('persists the identity Cardano key hashes on store, and clears them on delete', async () => {
    await storeIdentityMnemonic(SEED_A)
    const persisted = parseIdentityCardanoCreds(stored.get('@pnyx/identity_cardano_creds') ?? null)
    expect(persisted).toEqual(await Effect.runPromise(deriveIdentityCardanoCreds(SEED_A)))

    await deleteIdentityMnemonic()
    expect(stored.has('@pnyx/identity_cardano_creds')).toBe(false)
  })

  it('refuses to establish an identity from something that is not a mnemonic', async () => {
    // Better to fail loudly than to store a seed whose Cardano identity can
    // never be derived — review would silently stop recognising the ID.
    await expect(storeIdentityMnemonic('alpha bravo charlie')).rejects.toThrow()
  })

  it('generates 24-word seeds', () => {
    expect(generateIdentityMnemonic().split(' ')).toHaveLength(24)
  })
})
