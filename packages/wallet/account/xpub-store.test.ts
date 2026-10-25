/**
 * Tests for XPubStore — unified xpub storage keyed by (groupId, chainId, accountIndex).
 *
 * @module
 */

import {describe, expect, it} from '@effect/vitest'
import {Option} from 'effect'
import type {ChainId, WalletGroupId} from '../types.js'
import {createXPubStore} from './xpub-store.js'

const groupId = 'group-test-abc' as WalletGroupId
const chainId = 'cardano' as ChainId

const makeXPub = (byte: number, length = 64): Uint8Array => new Uint8Array(length).fill(byte)

const groupId2 = 'group-test-def' as WalletGroupId

describe('XPubStore', () => {
  it('stores and retrieves an xpub', () => {
    const store = createXPubStore()
    const xpub = makeXPub(0xaa)

    store.set({groupId, chainId, accountIndex: 0}, xpub)
    const result = store.get({groupId, chainId, accountIndex: 0})

    expect(Option.isSome(result)).toBe(true)
    expect(Option.getOrThrow(result)).toEqual(xpub)
  })

  it('returns None for missing xpubs', () => {
    const store = createXPubStore()
    const result = store.get({groupId, chainId, accountIndex: 0})

    expect(Option.isNone(result)).toBe(true)
  })

  it('retrieves all xpubs for a group across chains and accounts', () => {
    const store = createXPubStore()
    store.set({groupId, chainId: 'cardano' as ChainId, accountIndex: 0}, makeXPub(0x01))
    store.set({groupId, chainId: 'bitcoin' as ChainId, accountIndex: 0}, makeXPub(0x02))
    store.set({groupId, chainId: 'cardano' as ChainId, accountIndex: 1}, makeXPub(0x03))
    // Different group — should not appear
    store.set({groupId: groupId2, chainId: 'cardano' as ChainId, accountIndex: 0}, makeXPub(0xff))

    const all = store.getAllForGroup(groupId)

    expect(all.size).toBe(3)
  })

  it('retrieves all account xpubs for a group+chain', () => {
    const store = createXPubStore()
    store.set({groupId, chainId, accountIndex: 0}, makeXPub(0x01))
    store.set({groupId, chainId, accountIndex: 1}, makeXPub(0x02))
    store.set({groupId, chainId, accountIndex: 2}, makeXPub(0x03))
    // Different chain — should not appear
    store.set({groupId, chainId: 'bitcoin' as ChainId, accountIndex: 0}, makeXPub(0xff))

    const accounts = store.getAllForGroupChain(groupId, chainId)

    expect(accounts.size).toBe(3)
    expect(accounts.get(0)).toEqual(makeXPub(0x01))
    expect(accounts.get(1)).toEqual(makeXPub(0x02))
    expect(accounts.get(2)).toEqual(makeXPub(0x03))
  })

  it('deletes all xpubs for a group', () => {
    const store = createXPubStore()
    store.set({groupId, chainId, accountIndex: 0}, makeXPub(0x01))
    store.set({groupId, chainId: 'bitcoin' as ChainId, accountIndex: 0}, makeXPub(0x02))
    store.set({groupId: groupId2, chainId, accountIndex: 0}, makeXPub(0xff))

    store.deleteGroup(groupId)

    expect(Option.isNone(store.get({groupId, chainId, accountIndex: 0}))).toBe(true)
    expect(Option.isNone(store.get({groupId, chainId: 'bitcoin' as ChainId, accountIndex: 0}))).toBe(true)
    // Other group untouched
    expect(Option.isSome(store.get({groupId: groupId2, chainId, accountIndex: 0}))).toBe(true)
  })

  it('serializes and deserializes round-trip', () => {
    const store = createXPubStore()
    const xpub1 = makeXPub(0xab)
    const xpub2 = makeXPub(0xcd, 65)
    store.set({groupId, chainId: 'cardano' as ChainId, accountIndex: 0}, xpub1)
    store.set({groupId, chainId: 'bitcoin' as ChainId, accountIndex: 0}, xpub2)

    const json = store.serialize()

    const store2 = createXPubStore()
    store2.deserialize(json)

    expect(Option.getOrThrow(store2.get({groupId, chainId: 'cardano' as ChainId, accountIndex: 0}))).toEqual(xpub1)
    expect(Option.getOrThrow(store2.get({groupId, chainId: 'bitcoin' as ChainId, accountIndex: 0}))).toEqual(xpub2)
  })

  it('keeps groups independent', () => {
    const store = createXPubStore()
    store.set({groupId, chainId, accountIndex: 0}, makeXPub(0x01))
    store.set({groupId: groupId2, chainId, accountIndex: 0}, makeXPub(0x02))

    const g1 = Option.getOrThrow(store.get({groupId, chainId, accountIndex: 0}))
    const g2 = Option.getOrThrow(store.get({groupId: groupId2, chainId, accountIndex: 0}))

    expect(g1).toEqual(makeXPub(0x01))
    expect(g2).toEqual(makeXPub(0x02))
  })
})
