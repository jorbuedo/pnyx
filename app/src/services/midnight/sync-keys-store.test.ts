/**
 * The residency rules of the held sync keys, and the one that a wallet's DUST depended on.
 *
 * ⚠️ **The regression these guard.** The cache used to be keyed `groupId:accountIndex`, with the
 * network only a *field* on the value. One account therefore held one network's key at a time, and
 * since `dust-key-book.ts` writes the book from this cache, deriving a key on one network evicted
 * and then overwrote the other network's persisted entry. Switching networks stranded the wallet it
 * left behind — the scheduler correctly refused a foreign-network key, nothing re-derived one
 * without a biometric prompt a scheduled tick may not raise, and the app rendered "no DUST",
 * indistinguishable from a wallet that has none.
 */

import {beforeEach, describe, expect, it, vi} from 'vitest'

vi.mock('../../logger', () => ({logger: {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}}))

const {
  allSyncKeys,
  canSyncWithoutPrompt,
  forgetAllSyncKeys,
  forgetSyncKeys,
  forgetSyncKeysForGroup,
  getSyncKeys,
  heldNetworksFor,
  putSyncKeys,
} = await import('./sync-keys-store')

const KEY = new Uint8Array(32).fill(0xaa)

const keysFor = (network: string) => ({dust: KEY, dustAddress: `mn_dust_${network}1aaa`, network})

beforeEach(() => {
  forgetAllSyncKeys()
})

describe('keying by network', () => {
  it('holds one account on several networks at once', () => {
    putSyncKeys('group-aaaa', 0, keysFor('preview'))
    putSyncKeys('group-aaaa', 0, keysFor('preprod'))

    // ⚠️ The whole defect in one assertion: under the old key the second put evicted the first.
    expect(getSyncKeys('group-aaaa', 0, 'preview')?.dustAddress).toBe('mn_dust_preview1aaa')
    expect(getSyncKeys('group-aaaa', 0, 'preprod')?.dustAddress).toBe('mn_dust_preprod1aaa')
    expect(allSyncKeys()).toHaveLength(2)
  })

  it('answers for the network asked about, not for whichever was stored last', () => {
    putSyncKeys('group-aaaa', 0, keysFor('preview'))

    expect(canSyncWithoutPrompt('group-aaaa', 0, 'preview')).toBe(true)
    expect(canSyncWithoutPrompt('group-aaaa', 0, 'preprod')).toBe(false)
    expect(getSyncKeys('group-aaaa', 0, 'preprod')).toBeUndefined()
  })

  it('names the networks an account does hold, so a caller can tell absent from elsewhere', () => {
    // "No key at all" asks for a first refresh; "a key, but not here" is a state a tick can never
    // clear on its own. Collapsing them into one `undefined` is what left the condition unsayable.
    putSyncKeys('group-aaaa', 0, keysFor('preview'))
    putSyncKeys('group-aaaa', 0, keysFor('mainnet'))

    expect(heldNetworksFor('group-aaaa', 0)).toEqual(['mainnet', 'preview'])
    expect(heldNetworksFor('group-aaaa', 1)).toEqual([])
    expect(heldNetworksFor('group-bbbb', 0)).toEqual([])
  })

  it('keeps accounts of one group apart on the same network', () => {
    putSyncKeys('group-aaaa', 0, keysFor('preprod'))
    putSyncKeys('group-aaaa', 1, keysFor('preprod'))

    expect(heldNetworksFor('group-aaaa', 0)).toEqual(['preprod'])
    expect(heldNetworksFor('group-aaaa', 1)).toEqual(['preprod'])
    expect(allSyncKeys()).toHaveLength(2)
  })

  it('carries the identity on the entry, so a groupId containing a colon survives', () => {
    // While the identity was parsed back out of the cache key, a third component made the account
    // index `NaN` for every wallet — silently, since a NaN key still round-trips through a Map.
    putSyncKeys('group-a:b', 7, keysFor('preprod'))

    expect(allSyncKeys()).toEqual([{groupId: 'group-a:b', accountIndex: 7, keys: keysFor('preprod')}])
  })
})

describe('forgetting', () => {
  it('drops an account on every network, because the account is what was disabled', () => {
    putSyncKeys('group-aaaa', 0, keysFor('preview'))
    putSyncKeys('group-aaaa', 0, keysFor('preprod'))
    putSyncKeys('group-aaaa', 1, keysFor('preprod'))

    forgetSyncKeys('group-aaaa', 0)

    expect(heldNetworksFor('group-aaaa', 0)).toEqual([])
    // The sibling account is a bystander and keeps its key.
    expect(heldNetworksFor('group-aaaa', 1)).toEqual(['preprod'])
  })

  it('drops a whole group across networks and counts the accounts dropped', () => {
    putSyncKeys('group-aaaa', 0, keysFor('preview'))
    putSyncKeys('group-aaaa', 0, keysFor('preprod'))
    putSyncKeys('group-bbbb', 0, keysFor('preprod'))

    expect(forgetSyncKeysForGroup('group-aaaa')).toBe(2)
    expect(heldNetworksFor('group-aaaa', 0)).toEqual([])
    expect(heldNetworksFor('group-bbbb', 0)).toEqual(['preprod'])
  })

  it('does not match a group whose id merely starts with another', () => {
    // The old implementation matched on a `groupId:` string prefix, which is only unambiguous while
    // the separator cannot appear in an id.
    putSyncKeys('group-aaaa', 0, keysFor('preprod'))
    putSyncKeys('group-aaaabbbb', 0, keysFor('preprod'))

    expect(forgetSyncKeysForGroup('group-aaaa')).toBe(1)
    expect(heldNetworksFor('group-aaaabbbb', 0)).toEqual(['preprod'])
  })
})
