/**
 * Unified XPub storage keyed by (groupId, chain namespace, accountIndex).
 *
 * The API accepts full `ChainId` values for ergonomics, but internally
 * the storage key uses only the CAIP-2 namespace (eip155, bip122, cardano,
 * ...). Chains within the same namespace share the same HD derivation
 * subtree (same coin type, same curve) and therefore the same xpub — for
 * example eip155:1 and eip155:11155111 derive from identical HD nodes, so
 * caching them under one key avoids duplicate storage and accidental
 * inconsistency if one copy gets regenerated.
 *
 * @module
 */

import {getChainNamespace} from '@pnyx/config'
import {hex} from '@pnyx/crypto'
import {Either, Option} from 'effect'
import type {ChainId, WalletGroupId} from '../types.js'

/**
 * Composite key for xpub lookup.
 */
export type XPubKey = {
  readonly groupId: WalletGroupId
  readonly chainId: ChainId
  readonly accountIndex: number
}

/**
 * Unified xpub store interface.
 */
export type XPubStore = {
  readonly get: (key: XPubKey) => Option.Option<Uint8Array>
  readonly set: (key: XPubKey, xpub: Uint8Array) => void
  readonly getAllForGroup: (groupId: WalletGroupId) => ReadonlyMap<string, Uint8Array>
  readonly getAllForGroupChain: (groupId: WalletGroupId, chainId: ChainId) => ReadonlyMap<number, Uint8Array>
  readonly deleteGroup: (groupId: WalletGroupId) => void
  readonly serialize: () => string
  readonly deserialize: (json: string) => void
}

const toStorageKey = (key: XPubKey): string => `${key.groupId}:${getChainNamespace(key.chainId)}:${key.accountIndex}`

/**
 * Create a new XPubStore instance.
 */
export const createXPubStore = (): XPubStore => {
  const entries = new Map<string, Uint8Array>()

  const get = (key: XPubKey): Option.Option<Uint8Array> => {
    const xpub = entries.get(toStorageKey(key))
    return xpub ? Option.some(new Uint8Array(xpub)) : Option.none()
  }

  const set = (key: XPubKey, xpub: Uint8Array): void => {
    entries.set(toStorageKey(key), new Uint8Array(xpub))
  }

  const getAllForGroup = (groupId: WalletGroupId): ReadonlyMap<string, Uint8Array> => {
    const result = new Map<string, Uint8Array>()
    const prefix = `${groupId}:`
    for (const [k, v] of entries) {
      if (k.startsWith(prefix)) {
        result.set(k, v)
      }
    }
    return result
  }

  const getAllForGroupChain = (groupId: WalletGroupId, chainId: ChainId): ReadonlyMap<number, Uint8Array> => {
    const result = new Map<number, Uint8Array>()
    const prefix = `${groupId}:${getChainNamespace(chainId)}:`
    for (const [k, v] of entries) {
      if (k.startsWith(prefix)) {
        const accountIndex = Number.parseInt(k.slice(prefix.length), 10)
        result.set(accountIndex, v)
      }
    }
    return result
  }

  const deleteGroup = (groupId: WalletGroupId): void => {
    const prefix = `${groupId}:`
    for (const k of entries.keys()) {
      if (k.startsWith(prefix)) {
        entries.delete(k)
      }
    }
  }

  const serialize = (): string => {
    const data: Record<string, string> = {}
    for (const [k, v] of entries) {
      data[k] = hex.encode(v)
    }
    return JSON.stringify(data)
  }

  const deserialize = (json: string): void => {
    const data = JSON.parse(json) as Record<string, string>
    entries.clear()
    for (const [k, value] of Object.entries(data)) {
      entries.set(
        k,
        Either.getOrThrowWith(hex.decode(value), (e) => new Error(`Invalid hex xpub for key ${k}: ${e.message}`)),
      )
    }
  }

  return {get, set, getAllForGroup, getAllForGroupChain, deleteGroup, serialize, deserialize}
}
